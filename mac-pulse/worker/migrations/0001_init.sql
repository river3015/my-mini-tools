-- Hosts that send samples. Values that depend only on the host live here
-- instead of on every sample row.
CREATE TABLE hosts (
  id               INTEGER PRIMARY KEY,
  name             TEXT    NOT NULL UNIQUE,  -- display name; renaming does not touch samples
  token_hash       TEXT    NOT NULL UNIQUE,  -- SHA-256 (hex) of the ingest token
  model            TEXT,                     -- e.g. MacBookPro17,1
  mem_total_bytes  INTEGER,
  disk_total_bytes INTEGER,
  created_at       INTEGER NOT NULL
);

-- One row per minute per host, kept for 7 days.
-- processes and jobs are JSON on purpose (not 1NF): they are written and read
-- as one snapshot, and a child table would multiply D1 rows written by ~16.
CREATE TABLE samples (
  host_id              INTEGER NOT NULL REFERENCES hosts(id),
  ts                   INTEGER NOT NULL,  -- measured on the host (UNIX seconds, UTC)
  received_at          INTEGER NOT NULL,  -- when the Worker stored it
  mem_used_bytes       INTEGER NOT NULL,  -- app (anonymous - purgeable) + wired + compressed
  mem_compressed_bytes INTEGER NOT NULL,
  mem_free_pct         INTEGER NOT NULL,  -- kern.memorystatus_level
  mem_pressure         INTEGER NOT NULL,  -- 1 normal, 2 warning, 4 critical
  swap_total_bytes     INTEGER NOT NULL,
  swap_used_bytes      INTEGER NOT NULL,
  swapins              INTEGER NOT NULL,  -- counters since boot
  swapouts             INTEGER NOT NULL,
  load1                REAL    NOT NULL,
  load5                REAL    NOT NULL,
  cpu_speed_limit      INTEGER,           -- pmset -g therm; NULL when not reported
  disk_free_bytes      INTEGER NOT NULL,
  battery_pct          INTEGER,
  on_ac                INTEGER,
  uptime_s             INTEGER NOT NULL,
  processes            TEXT    NOT NULL,  -- [{"name","count","rss_bytes","cpu_pct"}], top by memory
  jobs                 TEXT    NOT NULL,  -- {"<launchd label>": {"pid", "last_exit"}}
  PRIMARY KEY (host_id, ts)
) WITHOUT ROWID;

-- Hourly rollup of samples, kept for 90 days. Derived data on purpose:
-- samples are deleted after 7 days.
CREATE TABLE samples_hourly (
  host_id          INTEGER NOT NULL REFERENCES hosts(id),
  hour_ts          INTEGER NOT NULL,  -- start of the hour
  n                INTEGER NOT NULL,  -- samples in the hour (60 when none are missing)
  mem_used_avg     INTEGER NOT NULL,
  mem_used_max     INTEGER NOT NULL,
  mem_pressure_max INTEGER NOT NULL,
  swap_used_max    INTEGER NOT NULL,
  swapouts_delta   INTEGER NOT NULL,
  load1_avg        REAL    NOT NULL,
  load1_max        REAL    NOT NULL,
  disk_free_min    INTEGER NOT NULL,
  PRIMARY KEY (host_id, hour_ts)
) WITHOUT ROWID;

-- Alert state, so a condition is notified when it starts and ends, not every run.
CREATE TABLE alerts (
  host_id     INTEGER NOT NULL REFERENCES hosts(id),
  kind        TEXT    NOT NULL,  -- stale / mem_pressure / disk_low / job_down:<label>
  firing      INTEGER NOT NULL,
  since       INTEGER NOT NULL,
  notified_at INTEGER,
  PRIMARY KEY (host_id, kind)
) WITHOUT ROWID;
