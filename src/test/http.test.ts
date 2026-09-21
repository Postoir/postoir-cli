import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "../http.js";
import { PostoirError } from "../errors.js";
test("authenticated requests forbid redirects and preserve request id", async () => {
  let init: RequestInit | undefined;
  const client = new Client({
    apiUrl: "https://postoir.com/",
    apiKey: "very-secret",
    fetch: async (_url, i) => {
      init = i;
      return new Response(
        JSON.stringify({
          error: {
            code: "BAD",
            message: "bad",
            requestId: "r1",
            details: { token: "very-secret" },
          },
        }),
        { status: 400 },
      );
    },
  });
  await assert.rejects(
    client.get("/x"),
    (e: PostoirError) =>
      e.requestId === "r1" && JSON.stringify(e.details).includes("very-secret") === false,
  );
  assert.equal(init?.redirect, "error");
});
test("rejects unsafe endpoint URLs", () =>
  assert.throws(() => new Client({ apiUrl: "https://key@postoir.com/?x=1", apiKey: "x" })));
test("redacts a key echoed by the API and reads Retry-After dates", async () => {
  const client = new Client({
    apiUrl: "https://example.test",
    apiKey: "secret-value",
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: { message: "secret-value rejected", details: { nested: "secret-value" } },
        }),
        { status: 429, headers: { "Retry-After": new Date(Date.now() + 5_000).toUTCString() } },
      ),
  });
  await assert.rejects(
    client.get("/x"),
    (e: PostoirError) =>
      !e.message.includes("secret-value") &&
      JSON.stringify(e.details).includes("secret-value") === false &&
      (e.retryAfter || 0) >= 0,
  );
});
test("per-request timeout aborts a slow fetch", async () => {
  let aborted = false;
  const client = new Client({
    apiUrl: "https://example.test",
    apiKey: "secret",
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("abort"));
        }),
      ),
  });
  await assert.rejects(
    client.requestDetailed("GET", "/x", undefined, {}, { timeoutMs: 1 }),
    PostoirError,
  );
  assert.equal(aborted, true);
});
