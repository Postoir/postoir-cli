import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

type Message = Record<string, any>;
const png = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3, 8, 2, 0, 0,
  0,
]);

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const instance = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("Could not bind test server");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        instance.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
async function child(apiUrl: string, throughCli = false) {
  const entry = new URL(throughCli ? "../cli.js" : "../mcp.js", import.meta.url).pathname;
  const proc = spawn(
    globalThis.process.execPath,
    [entry, ...(throughCli ? ["mcp", "serve"] : [])],
    {
      env: {
        ...globalThis.process.env,
        POSTOIR_API_KEY: "mcp-test-secret",
        POSTOIR_API_URL: apiUrl,
      },
      stdio: "pipe",
    },
  );
  let buffer = "";
  const pending: Message[] = [];
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (data: string) => {
    buffer += data;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line) pending.push(JSON.parse(line));
    }
  });
  async function request(value: Message): Promise<Message> {
    proc.stdin.write(`${JSON.stringify(value)}\n`);
    for (let tries = 0; tries < 100; tries++) {
      const found = pending.findIndex((message) => message.id === value.id);
      if (found >= 0) return pending.splice(found, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for MCP response");
  }
  return {
    process: proc,
    request,
    close: async () => {
      proc.stdin.end();
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    },
  };
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const part of request) chunks.push(Buffer.from(part));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
}

test("speaks MCP over clean stdio and exposes complete validated metadata", async () => {
  const api = await server((request, response) => {
    if (request.url?.startsWith("/api/v1/posts?"))
      return response.end(JSON.stringify({ data: [], pagination: { page: 2, perPage: 10 } }));
    response.writeHead(404).end();
  });
  const mcp = await child(api.origin, true);
  let stderr = "";
  mcp.process.stderr.setEncoding("utf8");
  mcp.process.stderr.on("data", (data: string) => {
    stderr += data;
  });
  try {
    const initialized = await mcp.request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {} },
    });
    assert.equal(initialized.result.protocolVersion, "2024-11-05");
    const listed = await mcp.request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(
      listed.result.tools.map((tool: Message) => tool.name),
      [
        "get_organization",
        "list_posts",
        "get_post",
        "create_draft_post",
        "update_draft_post",
        "delete_draft_post",
        "publish_post",
        "schedule_post",
        "cancel_post_schedule",
        "list_campaigns",
        "list_social_accounts",
        "list_media",
        "upload_media",
        "reserve_media_upload",
        "finalize_media_upload",
        "cancel_media_upload",
      ],
    );
    const create = listed.result.tools.find((tool: Message) => tool.name === "create_draft_post");
    assert.ok(create.inputSchema.properties.fullPrompt);
    assert.ok(create.inputSchema.properties.mediaGenerationPrompt);
    const posts = await mcp.request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_posts", arguments: { page: 2, perPage: 10, search: "hello" } },
    });
    assert.equal(posts.result.isError, undefined);
    const bad = await mcp.request({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "update_draft_post", arguments: { postId: "post-1" } },
    });
    assert.equal(bad.result.isError, true);
    assert.equal(bad.result.structuredContent.error.code, "INVALID_ARGUMENT");
    const ping = await mcp.request({ jsonrpc: "2.0", id: 5, method: "ping" });
    assert.deepEqual(ping.result, {});
    assert.equal(stderr, "");
  } finally {
    await Promise.all([mcp.close(), api.close()]);
  }
});

test("routes tool calls through Operations, strips control arguments, and preserves generated creation keys", async () => {
  let createBody: unknown;
  let updateBody: unknown;
  let createKey: string | undefined;
  const api = await server(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/v1/posts") {
      createBody = await body(request);
      createKey = request.headers["idempotency-key"] as string;
      response
        .writeHead(500, { "content-type": "application/json", "x-request-id": "req-1" })
        .end(JSON.stringify({ error: { code: "RETRY", message: "retry later" } }));
      return;
    }
    if (request.method === "PATCH" && request.url === "/api/v1/posts/post-1") {
      updateBody = await body(request);
      response.end(JSON.stringify({ data: { id: "post-1" } }));
      return;
    }
    if (request.method === "DELETE" && request.url === "/api/v1/posts/post-1")
      return response.writeHead(204).end();
    if (request.method === "DELETE" && request.url === "/api/v1/media/uploads/ticket-1")
      return response.writeHead(204).end();
    response.writeHead(404).end();
  });
  const mcp = await child(api.origin);
  try {
    const failed = await mcp.request({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "create_draft_post", arguments: { title: "Draft" } },
    });
    assert.equal(failed.result.structuredContent.error.code, "RETRY");
    assert.equal(failed.result.structuredContent.error.requestId, "req-1");
    assert.match(failed.result.structuredContent.error.idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.equal(createKey, failed.result.structuredContent.error.idempotencyKey);
    assert.deepEqual(createBody, { title: "Draft" });
    const updated = await mcp.request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "update_draft_post",
        arguments: { postId: "post-1", content: "Changed caf\u00e9" },
      },
    });
    assert.equal(updated.result.isError, undefined);
    assert.deepEqual(updateBody, { content: "Changed caf\u00e9" });
    const deleted = await mcp.request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "delete_draft_post", arguments: { postId: "post-1" } },
    });
    assert.match(deleted.result.content[0].text, /"deleted":true/);
    const cancelled = await mcp.request({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "cancel_media_upload", arguments: { ticketId: "ticket-1" } },
    });
    assert.match(cancelled.result.content[0].text, /"cancelled":true/);
  } finally {
    await Promise.all([mcp.close(), api.close()]);
  }
});

test("uses the local upload path through Operations and never writes non-protocol stdout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "postoir-mcp-test-"));
  const path = join(directory, "photo.png");
  await writeFile(path, png);
  let stored = 0;
  let finalized: unknown;
  const storage = await server((request, response) => {
    request.on("data", (part) => {
      stored += part.length;
    });
    request.on("end", () => response.end());
  });
  const api = await server(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/v1/media/uploads")
      return response.end(
        JSON.stringify({
          data: {
            ticketId: "ticket-1",
            uploadUrl: `${storage.origin}/signed`,
            size: png.length,
            mimeType: "image/png",
          },
        }),
      );
    if (request.method === "POST" && request.url === "/api/v1/media") {
      finalized = await body(request);
      return response.end(JSON.stringify({ data: { id: "media-1" } }));
    }
    response.writeHead(404).end();
  });
  const mcp = await child(api.origin);
  try {
    const response = await mcp.request({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "upload_media", arguments: { path, title: "Photo" } },
    });
    assert.equal(response.result.isError, undefined);
    assert.equal(stored, png.length);
    assert.deepEqual(finalized, { uploadTicket: "ticket-1", title: "Photo", width: 2, height: 3 });
  } finally {
    await Promise.all([
      mcp.close(),
      api.close(),
      storage.close(),
      rm(directory, { recursive: true, force: true }),
    ]);
  }
});
