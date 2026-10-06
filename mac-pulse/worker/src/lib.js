// Pure helpers for the Worker: validation, alert rules and time windows.
// Kept free of D1 and fetch so they run under node:test.

export const MAX_SAMPLES_PER_REQUEST = 30;
export const RAW_RETENTION_S = 7 * 24 * 3600;
export const HOURLY_RETENTION_S = 90 * 24 * 3600;
// Samples older than this are not used to judge memory, disk or jobs.
export const FRESH_S = 10 * 60;
export const REMIND_S = 6 * 3600;
export const PRESSURE_CRITICAL = 4;

const INT = (v) => Number.isSafeInteger(v);
const NUM = (v) => typeof v === "number" && Number.isFinite(v);
const nullable = (check) => (v) => v === null || check(v);

const SAMPLE_FIELDS = {
  ts: INT,
  mem_used_bytes: INT,
  mem_compressed_bytes: INT,
  mem_free_pct: INT,
  mem_pressure: INT,
  swap_total_bytes: INT,
  swap_used_bytes: INT,
  swapins: INT,
  swapouts: INT,
  load1: NUM,
  load5: NUM,
  cpu_speed_limit: nullable(INT),
  disk_free_bytes: INT,
  battery_pct: nullable(INT),
  on_ac: nullable(INT),
  uptime_s: INT,
};

const HOST_FIELDS = {
  model: (v) => typeof v === "string" && v.length <= 100,
  mem_total_bytes: INT,
  disk_total_bytes: INT,
};

export class ValidationError extends Error {}

function cleanProcesses(value) {
  if (!Array.isArray(value) || value.length > 20) throw new ValidationError("processes");
  return value.map((p) => {
    if (
      typeof p?.name !== "string" ||
      p.name.length > 100 ||
      !INT(p.count) ||
      !INT(p.rss_bytes) ||
      !NUM(p.cpu_pct)
    ) {
      throw new ValidationError("processes item");
    }
    return { name: p.name, count: p.count, rss_bytes: p.rss_bytes, cpu_pct: p.cpu_pct };
  });
}

function cleanJobs(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("jobs");
  }
  const entries = Object.entries(value);
  if (entries.length > 20) throw new ValidationError("jobs");
  const jobs = {};
  for (const [label, job] of entries) {
    if (label.length > 200 || !nullable(INT)(job?.pid) || !nullable(INT)(job?.last_exit)) {
      throw new ValidationError("jobs item");
    }
    jobs[label] = { pid: job.pid, last_exit: job.last_exit };
  }
  return jobs;
}

/** Validate an ingest body and return clean samples (unknown keys dropped). */
export function validateBatch(body, nowS) {
  const samples = body?.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new ValidationError("samples must be a non-empty array");
  }
  if (samples.length > MAX_SAMPLES_PER_REQUEST) {
    throw new ValidationError(`at most ${MAX_SAMPLES_PER_REQUEST} samples per request`);
  }
  return samples.map((s) => {
    const clean = {};
    for (const [key, check] of Object.entries({ ...SAMPLE_FIELDS, ...HOST_FIELDS })) {
      if (!check(s?.[key])) throw new ValidationError(`invalid ${key}`);
      clean[key] = s[key];
    }
    if (clean.ts < nowS - 2 * 24 * 3600 || clean.ts > nowS + 300) {
      throw new ValidationError("ts out of range");
    }
    clean.processes = cleanProcesses(s.processes);
    clean.jobs = cleanJobs(s.jobs);
    return clean;
  });
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Decide which alert conditions hold for one host.
 * latest is the newest sample row (processes/jobs already parsed) or null.
 * Returns { kind: { firing, detail } }. Kinds that cannot be judged are left out.
 */
export function evaluateAlerts(latest, nowS, { staleMinutes, diskLowGb }) {
  const result = {};
  const age = latest ? nowS - latest.ts : Infinity;
  if (staleMinutes > 0) {
    result.stale = { firing: age > staleMinutes * 60, detail: { age } };
  }
  if (!latest || age > FRESH_S) return result;
  result.mem_pressure = {
    firing: latest.mem_pressure >= PRESSURE_CRITICAL,
    detail: { swap_used_bytes: latest.swap_used_bytes },
  };
  result.disk_low = {
    firing: latest.disk_free_bytes < diskLowGb * 1e9,
    detail: { disk_free_bytes: latest.disk_free_bytes },
  };
  for (const [label, job] of Object.entries(latest.jobs)) {
    result[`job_down:${label}`] = {
      firing: job.pid === null,
      detail: { last_exit: job.last_exit },
    };
  }
  return result;
}

/**
 * Compare conditions with stored alert rows and return the changes to make.
 * rows: [{ kind, firing, since, notified_at }]. Firing rows whose condition can
 * no longer be judged stay as they are, unless the host is fresh (then the
 * condition went away, e.g. a job was removed from watch_jobs).
 */
export function alertTransitions(conditions, rows, nowS, hostIsFresh) {
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  const changes = [];
  const kinds = new Set([...Object.keys(conditions), ...byKind.keys()]);
  for (const kind of kinds) {
    const row = byKind.get(kind);
    const cond = conditions[kind] ?? (hostIsFresh ? { firing: false, detail: {} } : null);
    if (!cond) continue;
    const wasFiring = row?.firing === 1;
    if (cond.firing && !wasFiring) {
      changes.push({ kind, firing: 1, since: nowS, notify: "fired", detail: cond.detail });
    } else if (!cond.firing && wasFiring) {
      changes.push({ kind, firing: 0, since: nowS, notify: "resolved", detail: cond.detail });
    } else if (cond.firing && wasFiring && nowS - (row.notified_at ?? 0) >= REMIND_S) {
      changes.push({ kind, firing: 1, since: row.since, notify: "reminder", detail: cond.detail });
    }
  }
  return changes;
}

// Disk in decimal GB (like Finder), memory in binary GB (like Activity Monitor).
const GB = (bytes) => (bytes / 1e9).toFixed(1);
const GIB = (bytes) => (bytes / 2 ** 30).toFixed(1);

export function alertMessage(hostName, change, timeZone) {
  const { kind, notify, detail } = change;
  const resolved = notify === "resolved";
  const mark = resolved ? "✅" : notify === "reminder" ? "🔁" : "🔴";
  let text;
  if (kind === "stale") {
    text = resolved
      ? "データがまた届くようになりました"
      : `${Math.round(detail.age / 60)} 分データが届いていません`;
  } else if (kind === "mem_pressure") {
    text = resolved
      ? "メモリプレッシャーが危険な水準から戻りました"
      : `メモリプレッシャーが危険な水準です（スワップ ${GIB(detail.swap_used_bytes)} GB）`;
  } else if (kind === "disk_low") {
    text = resolved
      ? `ディスクの空きが戻りました（${GB(detail.disk_free_bytes)} GB）`
      : `ディスクの空きが ${GB(detail.disk_free_bytes)} GB です`;
  } else if (kind.startsWith("job_down:")) {
    const label = kind.slice("job_down:".length);
    text = resolved
      ? `${label} がまた動いています`
      : `${label} が動いていません（終了コード ${detail.last_exit ?? "不明"}）`;
  } else {
    text = kind;
  }
  const time = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
  return `${mark} ${hostName}: ${text}（${time}）`;
}

/** Hours to roll up on the run at the top of an hour: the last two complete hours. */
export function rollupWindow(nowS) {
  const hourStart = Math.floor(nowS / 3600) * 3600;
  return { from: hourStart - 2 * 3600, to: hourStart };
}

export const RANGES = {
  "24h": { seconds: 24 * 3600, table: "samples" },
  "7d": { seconds: 7 * 24 * 3600, table: "samples_hourly" },
  "30d": { seconds: 30 * 24 * 3600, table: "samples_hourly" },
  "90d": { seconds: 90 * 24 * 3600, table: "samples_hourly" },
};

// `wrangler dev` simulates Access with one identity (a person), so locally the
// collector may ingest with it. A real AUD tag is a hex string and never equals this.
export const LOCAL_DEV_AUD = "local-dev";

/**
 * Who came through Access: "user" for a person who signed in (the identity has
 * an email), otherwise "service" for the collector's service token, which
 * carries no email.
 */
export function accessCaller(identity) {
  return typeof identity?.email === "string" && identity.email !== "" ? "user" : "service";
}

/** Only the service token may ingest; only a person may read the dashboard and API. */
export function callerAllowed(caller, method, pathname, aud) {
  if (method === "POST" && pathname === "/api/ingest") {
    return caller === "service" || aud === LOCAL_DEV_AUD;
  }
  return caller === "user";
}
