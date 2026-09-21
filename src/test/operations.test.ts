import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "../http.js";
import { Operations } from "../operations.js";

test("all pagination strips an initial page and uses pages once", async () => {
  const paths: string[] = [];
  const client = new Client({
    apiUrl: "https://example.test",
    apiKey: "secret",
    fetch: async (url) => {
      paths.push(String(url));
      const page = new URL(String(url)).searchParams.get("page");
      return new Response(
        JSON.stringify({ data: [page], pagination: { page: Number(page), totalPages: 2 } }),
      );
    },
  });
  assert.deepEqual(await new Operations(client).posts(true, { page: "9", perPage: "5" }), [
    "1",
    "2",
  ]);
  assert.deepEqual(
    paths.map((p) => new URL(p).searchParams.get("page")),
    ["1", "2"],
  );
});
test("watch returns partial terminal status and honors a completed response", async () => {
  const client = new Client({
    apiUrl: "https://example.test",
    apiKey: "secret",
    fetch: async () =>
      new Response(
        JSON.stringify({
          data: {
            socialAccountIds: ["a", "b"],
            publications: [
              { socialAccountId: "a", status: "PUBLISHED" },
              { socialAccountId: "b", status: "FAILED" },
            ],
          },
        }),
      ),
  });
  const result = await new Operations(client).watch("post", { timeoutMs: 100 });
  assert.equal(result.complete, true);
  assert.equal(result.publications.length, 2);
});
test("watch does not complete when a requested account has no terminal publication", async () => {
  const client = new Client({
    apiUrl: "https://example.test",
    apiKey: "secret",
    fetch: async () =>
      new Response(
        JSON.stringify({
          data: {
            socialAccountIds: ["a", "b"],
            publications: [{ socialAccountId: "a", status: "PUBLISHED" }],
          },
        }),
      ),
  });
  const result = await new Operations(client).watch("post", { timeoutMs: 1, intervalMs: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.timedOut, true);
});
test("watch honors Retry-After returned on a successful poll", async () => {
  let calls = 0;
  const client = new Client({
    apiUrl: "https://example.test",
    apiKey: "secret",
    fetch: async () => {
      calls++;
      return new Response(JSON.stringify({ data: { socialAccountIds: ["a"], publications: [] } }), {
        headers: { "retry-after": "1" },
      });
    },
  });
  const result = await new Operations(client).watch("post", { timeoutMs: 20, intervalMs: 1 });
  assert.equal(result.timedOut, true);
  assert.equal(calls, 1);
});
test("queue failure rereads but does not issue a second publish", async () => {
  const methods: string[] = [];
  const client = new Client({
    apiUrl: "https://example.test",
    apiKey: "secret",
    fetch: async (_url, init) => {
      methods.push(String(init?.method));
      if (init?.method === "POST")
        return new Response(
          JSON.stringify({ error: { code: "PUBLICATION_QUEUE_UNAVAILABLE", message: "queued" } }),
          { status: 503 },
        );
      return new Response(JSON.stringify({ data: { id: "p" } }));
    },
  });
  const result = await new Operations(client).publishWithReconciliation("p");
  assert.equal(result.accepted, false);
  assert.deepEqual(methods, ["POST", "GET"]);
});
test("failed create exposes a generated idempotency key", async () => {
  const client = new Client({
    apiUrl: "https://example.test",
    apiKey: "secret",
    fetch: async () => new Response("no", { status: 503 }),
  });
  await assert.rejects(
    new Operations(client).createPost({ socialAccountIds: ["a"] }),
    (error: unknown) => typeof (error as { idempotencyKey?: unknown }).idempotencyKey === "string",
  );
});
test("schedule queue failure rereads once and preserves the reconciled post", async () => {
  const methods: string[] = [];
  const client = new Client({
    apiUrl: "https://example.test",
    apiKey: "secret",
    fetch: async (_url, init) => {
      methods.push(String(init?.method));
      if (init?.method === "POST")
        return new Response(
          JSON.stringify({ error: { code: "PUBLICATION_QUEUE_UNAVAILABLE", message: "queued" } }),
          { status: 503 },
        );
      return new Response(JSON.stringify({ data: { id: "p", status: "SCHEDULED" } }));
    },
  });
  await assert.rejects(
    new Operations(client).schedule("p", "2030-01-01T01:00:00Z"),
    (error: unknown) => {
      const details = (error as { details?: { post?: unknown } }).details;
      return !!details?.post;
    },
  );
  assert.deepEqual(methods, ["POST", "GET"]);
});
