// ローカルの画面と API。127.0.0.1 だけで待ち受ける。

import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { collectSessions, writeAck } from "./store.js";
import { createNotifier } from "./notify.js";

const INDEX_HTML = fileURLToPath(new URL("../public/index.html", import.meta.url));

export function startServer({ p, opts, port, wipLimit, notify, digestMinutes }) {
  let sessions = [];
  let updatedAt = 0;
  const onSessions = notify ? createNotifier({ digestMinutes }) : () => {};

  function refresh() {
    try {
      sessions = collectSessions(p, opts);
      updatedAt = Date.now();
      onSessions(sessions);
    } catch (err) {
      console.error("attn: 読み込みに失敗しました:", err.message);
    }
  }
  refresh();
  const timer = setInterval(refresh, 3000);

  const server = http.createServer(async (req, res) => {
    // 指示の本文を返すので、DNS リバインディングで外のサイトから読まれないよう Host を確かめる。
    if (!isLocalHost(req.headers.host)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(INDEX_HTML));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      sendJson(res, 200, { updatedAt, wipLimit, sessions });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/ack") {
      // ほかのサイトから確認済みにされないよう、同じオリジンからの JSON だけを受ける。
      if (req.headers["content-type"] !== "application/json" || !isLocalOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
      const body = await readJson(req);
      const targets = body?.all ? sessions.filter((x) => x.status === "your_turn") : sessions.filter((x) => x.key === body?.key);
      if (!body?.all && targets.length === 0) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      for (const s of targets) writeAck(p, s.key, body.undo ? null : s.lastActivity);
      refresh();
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`attn: http://127.0.0.1:${server.address().port}/ で表示しています（Ctrl-C で終了）`);
  });
  server.on("close", () => clearInterval(timer));
  return server;
}

function isLocalHost(host) {
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host ?? "");
}

function isLocalOrigin(origin) {
  if (!origin) return true; // curl など
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

function sendJson(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
  });
}
