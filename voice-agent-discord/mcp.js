// 常駐させた claude にボットの機能（ジョブの開始など）を渡すための、最小限の MCP サーバー（Streamable HTTP）。
// 127.0.0.1 だけで待ち受け、起動ごとに変わるトークンを URL に含めて、ほかのプロセスから呼ばれないようにする
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

// tools: { name: { description, inputSchema, handler(args) => string } }。handler が投げた例外はエラーとして返す
export async function startMcpServer(name, tools) {
  const token = randomBytes(16).toString("hex");
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== `/${token}/mcp`) {
      res.writeHead(req.url?.startsWith(`/${token}/`) ? 405 : 404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    // 通知（id なし）には返事をしない
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const reply = (payload) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...payload }));
    };
    if (msg.method === "initialize") {
      reply({
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name, version: "1.0.0" },
        },
      });
    } else if (msg.method === "ping") {
      reply({ result: {} });
    } else if (msg.method === "tools/list") {
      const list = Object.entries(tools).map(([n, t]) => ({ name: n, description: t.description, inputSchema: t.inputSchema }));
      reply({ result: { tools: list } });
    } else if (msg.method === "tools/call") {
      const tool = tools[msg.params?.name];
      if (!tool) {
        reply({ error: { code: -32602, message: `unknown tool: ${msg.params?.name}` } });
        return;
      }
      try {
        const text = await tool.handler(msg.params.arguments ?? {});
        reply({ result: { content: [{ type: "text", text }] } });
      } catch (err) {
        reply({ result: { content: [{ type: "text", text: err.message }], isError: true } });
      }
    } else {
      reply({ error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/${token}/mcp`;
  return { url, close: () => server.close() };
}
