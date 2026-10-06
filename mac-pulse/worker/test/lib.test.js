import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LOCAL_DEV_AUD,
  REMIND_S,
  ValidationError,
  accessCaller,
  alertMessage,
  alertTransitions,
  callerAllowed,
  evaluateAlerts,
  rollupWindow,
  sha256Hex,
  validateBatch,
} from "../src/lib.js";

const NOW = 1_800_000_000;

function sample(overrides = {}) {
  return {
    ts: NOW - 30,
    model: "MacBookPro17,1",
    mem_total_bytes: 8589934592,
    disk_total_bytes: 494384795648,
    mem_used_bytes: 7068090368,
    mem_compressed_bytes: 3200647168,
    mem_free_pct: 32,
    mem_pressure: 2,
    swap_total_bytes: 5368709120,
    swap_used_bytes: 4469030912,
    swapins: 1,
    swapouts: 2,
    load1: 17.66,
    load5: 16.31,
    cpu_speed_limit: null,
    disk_free_bytes: 23843356672,
    battery_pct: 98,
    on_ac: 1,
    uptime_s: 1399594,
    processes: [{ name: "claude", count: 5, rss_bytes: 259489792, cpu_pct: 18.2, extra: "x" }],
    jobs: { "io.github.river3015.voice-input": { pid: 81502, last_exit: -15 } },
    unknown_field: "dropped",
    ...overrides,
  };
}

test("validateBatch keeps known fields only", () => {
  const [clean] = validateBatch({ samples: [sample()] }, NOW);
  assert.equal(clean.unknown_field, undefined);
  assert.deepEqual(clean.processes, [
    { name: "claude", count: 5, rss_bytes: 259489792, cpu_pct: 18.2 },
  ]);
  assert.equal(clean.cpu_speed_limit, null);
});

test("validateBatch rejects bad input", () => {
  const bad = [
    {},
    { samples: [] },
    { samples: Array(31).fill(sample()) },
    { samples: [sample({ mem_used_bytes: "1" })] },
    { samples: [sample({ load1: Infinity })] },
    { samples: [sample({ ts: NOW + 3600 })] },
    { samples: [sample({ ts: NOW - 3 * 24 * 3600 })] },
    { samples: [sample({ processes: [{ name: "a" }] })] },
    { samples: [sample({ jobs: [] })] },
    { samples: [sample({ model: "x".repeat(101) })] },
  ];
  for (const body of bad) {
    assert.throws(() => validateBatch(body, NOW), ValidationError, JSON.stringify(body).slice(0, 80));
  }
});

test("sha256Hex", async () => {
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

const options = { staleMinutes: 30, diskLowGb: 10 };
const row = (o = {}) => ({ ...sample(), jobs: sample().jobs, ...o });

test("evaluateAlerts on a fresh sample", () => {
  const result = evaluateAlerts(
    row({
      mem_pressure: 4,
      disk_free_bytes: 5e9,
      jobs: { a: { pid: null, last_exit: 78 }, b: { pid: 1, last_exit: 0 } },
    }),
    NOW,
    options,
  );
  assert.equal(result.stale.firing, false);
  assert.equal(result.mem_pressure.firing, true);
  assert.equal(result.disk_low.firing, true);
  assert.equal(result["job_down:a"].firing, true);
  assert.equal(result["job_down:b"].firing, false);
});

test("evaluateAlerts on an old sample judges only staleness", () => {
  const result = evaluateAlerts(row({ ts: NOW - 3600, mem_pressure: 4 }), NOW, options);
  assert.deepEqual(Object.keys(result), ["stale"]);
  assert.equal(result.stale.firing, true);
  assert.deepEqual(evaluateAlerts(null, NOW, { staleMinutes: 0, diskLowGb: 10 }), {});
});

test("alertTransitions fires, reminds, resolves", () => {
  const firing = { mem_pressure: { firing: true, detail: {} } };
  assert.deepEqual(
    alertTransitions(firing, [], NOW, true).map((c) => [c.kind, c.notify]),
    [["mem_pressure", "fired"]],
  );
  const stored = [{ kind: "mem_pressure", firing: 1, since: NOW - 60, notified_at: NOW - 60 }];
  assert.deepEqual(alertTransitions(firing, stored, NOW, true), []);
  const old = [{ ...stored[0], notified_at: NOW - REMIND_S }];
  assert.equal(alertTransitions(firing, old, NOW, true)[0].notify, "reminder");
  assert.equal(alertTransitions(firing, old, NOW, true)[0].since, NOW - 60);
  const ok = { mem_pressure: { firing: false, detail: {} } };
  assert.equal(alertTransitions(ok, stored, NOW, true)[0].notify, "resolved");
});

test("alertTransitions: firing rows without a condition", () => {
  const stored = [{ kind: "job_down:gone", firing: 1, since: NOW - 60, notified_at: NOW - 60 }];
  // Host fresh and the job is no longer watched: resolve.
  assert.equal(alertTransitions({}, stored, NOW, true)[0].notify, "resolved");
  // Host stale: cannot judge, keep as is.
  assert.deepEqual(alertTransitions({}, stored, NOW, false), []);
});

test("alertMessage", () => {
  const text = alertMessage(
    "mbp",
    { kind: "disk_low", notify: "fired", detail: { disk_free_bytes: 9.5e9 } },
    "Asia/Tokyo",
  );
  assert.match(text, /^🔴 mbp: ディスクの空きが 9\.5 GB です（\d\d:\d\d）$/);
  const job = alertMessage(
    "mbp",
    { kind: "job_down:x.y", notify: "resolved", detail: {} },
    "Asia/Tokyo",
  );
  assert.match(job, /^✅ mbp: x\.y がまた動いています/);
});

test("rollupWindow covers the last two complete hours", () => {
  const top = Math.floor(NOW / 3600) * 3600;
  assert.deepEqual(rollupWindow(top + 120), { from: top - 7200, to: top });
});

test("accessCaller tells a person from the service token by email", () => {
  assert.equal(accessCaller({ email: "me@example.com", groups: [] }), "user");
  assert.equal(accessCaller({ email: "" }), "service");
  assert.equal(accessCaller({ common_name: "abc.access" }), "service");
  assert.equal(accessCaller(undefined), "service");
  assert.equal(accessCaller(null), "service");
});

test("callerAllowed keeps ingest for the service token and reading for people", () => {
  const aud = "0123abcd";
  assert.equal(callerAllowed("service", "POST", "/api/ingest", aud), true);
  assert.equal(callerAllowed("user", "POST", "/api/ingest", aud), false);
  for (const path of ["/", "/api/summary", "/api/hosts", "/nope"]) {
    assert.equal(callerAllowed("user", "GET", path, aud), true, path);
    assert.equal(callerAllowed("service", "GET", path, aud), false, path);
  }
  assert.equal(callerAllowed("service", "GET", "/api/ingest", aud), false);
  assert.equal(callerAllowed("user", "POST", "/api/ingest", LOCAL_DEV_AUD), true);
});
