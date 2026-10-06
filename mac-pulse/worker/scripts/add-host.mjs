// Register a host and print its ingest token once. Only the SHA-256 of the
// token is stored in D1.
// Usage: npm run add-host -- <name> --local|--remote
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const [name, where] = process.argv.slice(2);
if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name ?? "") || !["--local", "--remote"].includes(where)) {
  console.error("usage: npm run add-host -- <name: a-z, 0-9, -> --local|--remote");
  process.exit(2);
}
const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
const now = Math.floor(Date.now() / 1000);
execFileSync(
  "npx",
  [
    "wrangler", "d1", "execute", "mac-pulse", where, "--command",
    `INSERT INTO hosts (name, token_hash, created_at) VALUES ('${name}', '${hash}', ${now})`,
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);
console.log(`registered ${name}. Store this token on the host (shown only once):`);
console.log(token);
