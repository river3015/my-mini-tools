// mac-pulse Worker: stores samples from the collector in D1, serves the
// dashboard and its API, and sends alerts to Discord on a cron trigger.
// Every request must come through Cloudflare Access (ctx.access); ingest also
// needs the per-host bearer token.

import dashboard from "./dashboard.html";
import {
  FRESH_S,
  HOURLY_RETENTION_S,
  RANGES,
  RAW_RETENTION_S,
  ValidationError,
  alertMessage,
  alertTransitions,
  evaluateAlerts,
  rollupWindow,
  sha256Hex,
  validateBatch,
} from "./lib.js";

const MAX_BODY_BYTES = 1 << 20;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const nowS = () => Math.floor(Date.now() / 1000);

export default {
  async fetch(request, env, ctx) {
    if (!env.ACCESS_AUD) return json({ error: "ACCESS_AUD is not set" }, 500);
    if (!ctx.access || ctx.access.aud !== env.ACCESS_AUD) {
      return json({ error: "Cloudflare Access is required" }, 403);
    }
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/api/ingest") {
        return await ingest(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/hosts") {
        return json(await listHosts(env));
      }
      if (request.method === "GET" && url.pathname === "/api/summary") {
        return await summary(url, env);
      }
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(dashboard, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          },
        });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      if (e instanceof ValidationError) return json({ error: e.message }, 400);
      throw e;
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runSchedule(env, Math.floor(controller.scheduledTime / 1000)));
  },
};

async function ingest(request, env) {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!token) return json({ error: "missing token" }, 401);
  const host = await env.DB.prepare(
    "SELECT id, model, mem_total_bytes, disk_total_bytes FROM hosts WHERE token_hash = ?",
  )
    .bind(await sha256Hex(token))
    .first();
  if (!host) return json({ error: "unknown token" }, 401);

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return json({ error: "body too large" }, 413);
  let body;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("body is not JSON");
  }
  const now = nowS();
  const samples = validateBatch(body, now);

  const insert = env.DB.prepare(
    `INSERT OR IGNORE INTO samples (host_id, ts, received_at, mem_used_bytes,
       mem_compressed_bytes, mem_free_pct, mem_pressure, swap_total_bytes, swap_used_bytes,
       swapins, swapouts, load1, load5, cpu_speed_limit, disk_free_bytes, battery_pct, on_ac,
       uptime_s, processes, jobs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const statements = samples.map((s) =>
    insert.bind(
      host.id,
      s.ts,
      now,
      s.mem_used_bytes,
      s.mem_compressed_bytes,
      s.mem_free_pct,
      s.mem_pressure,
      s.swap_total_bytes,
      s.swap_used_bytes,
      s.swapins,
      s.swapouts,
      s.load1,
      s.load5,
      s.cpu_speed_limit,
      s.disk_free_bytes,
      s.battery_pct,
      s.on_ac,
      s.uptime_s,
      JSON.stringify(s.processes),
      JSON.stringify(s.jobs),
    ),
  );
  // Host facts change rarely; update only when they differ to save rows written.
  const last = samples.at(-1);
  if (
    last.model !== host.model ||
    last.mem_total_bytes !== host.mem_total_bytes ||
    last.disk_total_bytes !== host.disk_total_bytes
  ) {
    statements.push(
      env.DB.prepare(
        "UPDATE hosts SET model = ?, mem_total_bytes = ?, disk_total_bytes = ? WHERE id = ?",
      ).bind(last.model, last.mem_total_bytes, last.disk_total_bytes, host.id),
    );
  }
  await env.DB.batch(statements);
  return json({ stored: samples.length });
}

async function listHosts(env) {
  const { results } = await env.DB.prepare(
    `SELECT h.name, h.model, h.mem_total_bytes, h.disk_total_bytes,
            (SELECT MAX(ts) FROM samples s WHERE s.host_id = h.id) AS last_ts
     FROM hosts h ORDER BY h.name`,
  ).all();
  return results;
}

async function summary(url, env) {
  const range = RANGES[url.searchParams.get("range") ?? "24h"];
  if (!range) throw new ValidationError("range must be one of " + Object.keys(RANGES).join(", "));
  const name = url.searchParams.get("host");
  const host = await env.DB.prepare(
    `SELECT id, name, model, mem_total_bytes, disk_total_bytes FROM hosts
     ${name ? "WHERE name = ?" : ""} ORDER BY name LIMIT 1`,
  )
    .bind(...(name ? [name] : []))
    .first();
  if (!host) return json({ error: "host not found" }, 404);

  const from = nowS() - range.seconds;
  const latestRow = await env.DB.prepare(
    "SELECT * FROM samples WHERE host_id = ? ORDER BY ts DESC LIMIT 1",
  )
    .bind(host.id)
    .first();
  const seriesQuery =
    range.table === "samples"
      ? `SELECT ts, mem_used_bytes AS mem_used, swap_used_bytes AS swap_used,
                disk_free_bytes AS disk_free, load1, mem_pressure AS pressure
         FROM samples WHERE host_id = ? AND ts >= ? ORDER BY ts`
      : `SELECT hour_ts AS ts, mem_used_max AS mem_used, swap_used_max AS swap_used,
                disk_free_min AS disk_free, load1_avg AS load1, mem_pressure_max AS pressure
         FROM samples_hourly WHERE host_id = ? AND hour_ts >= ? ORDER BY hour_ts`;
  const [{ results: series }, { results: alerts }] = await env.DB.batch([
    env.DB.prepare(seriesQuery).bind(host.id, from),
    env.DB.prepare("SELECT kind, since FROM alerts WHERE host_id = ? AND firing = 1").bind(host.id),
  ]);
  const latest = latestRow && {
    ...latestRow,
    processes: JSON.parse(latestRow.processes),
    jobs: JSON.parse(latestRow.jobs),
  };
  return json({
    host,
    now: nowS(),
    granularity: range.table === "samples" ? "minute" : "hour",
    latest,
    series,
    alerts,
  });
}

async function runSchedule(env, now) {
  await checkAlerts(env, now);
  // The */5 cron fires at minute 0 of each hour once.
  if (new Date(now * 1000).getUTCMinutes() < 5) await rollupAndPrune(env, now);
}

async function checkAlerts(env, now) {
  const { results: hosts } = await env.DB.prepare("SELECT id, name FROM hosts").all();
  const options = {
    staleMinutes: Number(env.STALE_MINUTES ?? 0),
    diskLowGb: Number(env.DISK_LOW_GB ?? 10),
  };
  for (const host of hosts) {
    const latestRow = await env.DB.prepare(
      "SELECT ts, mem_pressure, swap_used_bytes, disk_free_bytes, jobs FROM samples WHERE host_id = ? ORDER BY ts DESC LIMIT 1",
    )
      .bind(host.id)
      .first();
    const latest = latestRow && { ...latestRow, jobs: JSON.parse(latestRow.jobs) };
    const { results: rows } = await env.DB.prepare(
      "SELECT kind, firing, since, notified_at FROM alerts WHERE host_id = ?",
    )
      .bind(host.id)
      .all();
    const fresh = latest !== null && now - latest.ts <= FRESH_S;
    const changes = alertTransitions(evaluateAlerts(latest, now, options), rows, now, fresh);
    if (changes.length === 0) continue;

    const upsert = env.DB.prepare(
      `INSERT INTO alerts (host_id, kind, firing, since, notified_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (host_id, kind) DO UPDATE SET
         firing = excluded.firing, since = excluded.since, notified_at = excluded.notified_at`,
    );
    await env.DB.batch(changes.map((c) => upsert.bind(host.id, c.kind, c.firing, c.since, now)));
    const text = changes.map((c) => alertMessage(host.name, c, env.TZ || "Asia/Tokyo")).join("\n");
    await notify(env, text);
  }
}

async function notify(env, content) {
  if (!env.DISCORD_WEBHOOK_URL) {
    console.log(`alert (no webhook): ${content}`);
    return;
  }
  const response = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!response.ok) console.error(`discord webhook failed: ${response.status}`);
}

async function rollupAndPrune(env, now) {
  const { from, to } = rollupWindow(now);
  await env.DB.batch([
    // swapouts is a counter since boot; a reboot inside the hour makes MAX-MIN
    // meaningless, so it is clamped at 0 and only used as a rough signal.
    env.DB.prepare(
      `INSERT OR REPLACE INTO samples_hourly
       SELECT host_id, (ts / 3600) * 3600, COUNT(*), CAST(AVG(mem_used_bytes) AS INTEGER),
              MAX(mem_used_bytes), MAX(mem_pressure), MAX(swap_used_bytes),
              MAX(0, MAX(swapouts) - MIN(swapouts)), AVG(load1), MAX(load1), MIN(disk_free_bytes)
       FROM samples WHERE ts >= ? AND ts < ?
       GROUP BY host_id, ts / 3600`,
    ).bind(from, to),
    env.DB.prepare("DELETE FROM samples WHERE ts < ?").bind(now - RAW_RETENTION_S),
    env.DB.prepare("DELETE FROM samples_hourly WHERE hour_ts < ?").bind(now - HOURLY_RETENTION_S),
  ]);
}
