import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

const cli = new URL("../cli.js", import.meta.url).pathname;
async function run(args: string[], env: Record<string, string> = {}, input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, ...env } },
      (error, stdout, stderr) =>
        resolve({ code: error && "code" in error ? Number(error.code) : 0, stdout, stderr }),
    );
    child.stdin?.end(input);
  });
}
async function server() {
  const api = createServer((request, response) => {
    if (request.url === "/api/v1/organization")
      response.end(JSON.stringify({ data: { id: "org-1" } }));
    else if (request.url?.startsWith("/api/v1/posts"))
      response.end(JSON.stringify({ data: [], pagination: { page: 2, totalPages: 2 } }));
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return { api, origin: `http://127.0.0.1:${address.port}` };
}

test("CLI reports help and rejects unknown options before network work", async () => {
  const help = await run(["--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /posts schedule/);
  const result = await run(["organization", "get", "--mistake"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option/);
});
test("login accepts stdin and status validates configured credentials remotely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "postoir-cli-"));
  const { api, origin } = await server();
  try {
    const env = { POSTOIR_CONFIG_PATH: join(directory, "config.json") };
    assert.equal(
      (await run(["auth", "login", "--api-url", origin, "--profile", "test"], env, "secret-key"))
        .code,
      0,
    );
    const status = await run(["--json", "auth", "status", "--profile", "test"], env);
    assert.equal(status.code, 0);
    assert.equal(JSON.parse(status.stdout).verified, true);
    assert.doesNotMatch(await readFile(env.POSTOIR_CONFIG_PATH, "utf8"), /POSTOIR_API_KEY/);
  } finally {
    api.close();
  }
});
test("mcp config is secret-free and skill install preserves existing destination", async () => {
  const config = await run(["mcp", "config", "cursor", "--api-url", "https://api.example"]);
  const parsed = JSON.parse(config.stdout);
  assert.deepEqual(parsed.mcpServers.postoir.args, ["mcp", "serve"]);
  assert.doesNotMatch(config.stdout, /API_KEY/);
  const directory = await mkdtemp(join(tmpdir(), "postoir-skill-"));
  await mkdir(join(directory, "postoir"));
  await writeFile(join(directory, "postoir", "keep"), "keep");
  const result = await run(["skills", "install", "--dir", directory]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Refusing to overwrite/);
});
test("post creation reads stdin and files, preserves update omissions, and paginates --all", async () => {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const api = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      urls.push(request.url || "");
      if (request.method === "POST" || request.method === "PATCH") {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.end(JSON.stringify({ data: { id: "post-1" } }));
        return;
      }
      const page = new URL(request.url || "/", "http://localhost").searchParams.get("page");
      response.end(
        JSON.stringify({
          data: [{ id: page || "1" }],
          pagination: { page: Number(page || 1), totalPages: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const env = { POSTOIR_API_KEY: "key", POSTOIR_API_URL: `http://127.0.0.1:${address.port}` };
  try {
    const directory = await mkdtemp(join(tmpdir(), "postoir-cli-copy-"));
    const copy = join(directory, "copy.txt");
    await writeFile(copy, "file draft");
    assert.equal(
      (
        await run(
          ["posts", "create", "--data", "-", "--idempotency-key", "retry=kept"],
          env,
          '{"content":"stdin","socialAccountIds":["a"]}',
        )
      ).code,
      0,
    );
    assert.equal((await run(["posts", "update", "post-1", "--content-file", copy], env)).code, 0);
    assert.equal((await run(["posts", "list", "--all", "--status", "DRAFT"], env)).code, 0);
    assert.equal((bodies[0] as { content: string }).content, "stdin");
    assert.equal((bodies[1] as { content: string }).content, "file draft");
    assert.equal("mediaIds" in bodies[1]!, false);
    assert.ok(urls.some((url) => url.includes("page=1") && url.includes("perPage=100")));
    assert.ok(urls.some((url) => url.includes("page=2") && url.includes("perPage=100")));
  } finally {
    api.close();
  }
});
test("schedule requires an ISO timezone and reports server targets; watch has distinct delivery exits", async () => {
  let mode = "PUBLISHED";
  const api = createServer((request, response) => {
    if (request.url?.endsWith("/schedule")) {
      response.end(
        JSON.stringify({
          data: {
            scheduledFor: "2035-01-15T09:00:00+01:00",
            socialAccountIds: ["account-1"],
            publications: [{ socialAccountId: "account-1", status: "PENDING" }],
          },
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        data: {
          socialAccountIds: ["account-1"],
          publications: [{ socialAccountId: "account-1", status: mode }],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const env = { POSTOIR_API_KEY: "key", POSTOIR_API_URL: `http://127.0.0.1:${address.port}` };
  try {
    assert.equal(
      (await run(["posts", "schedule", "post-1", "--at", "2035-01-15T09:00:00"], env)).code,
      2,
    );
    const scheduled = await run(
      ["posts", "schedule", "post-1", "--at", "2035-01-15T09:00:00+01:00"],
      env,
    );
    assert.equal(scheduled.code, 0);
    assert.match(scheduled.stdout, /account-1/);
    assert.equal((await run(["posts", "watch", "post-1", "--timeout", "100"], env)).code, 0);
    mode = "FAILED";
    assert.equal((await run(["posts", "watch", "post-1", "--timeout", "100"], env)).code, 6);
    mode = "RECONCILIATION_REQUIRED";
    assert.equal((await run(["posts", "watch", "post-1", "--timeout", "100"], env)).code, 7);
  } finally {
    api.close();
  }
});
