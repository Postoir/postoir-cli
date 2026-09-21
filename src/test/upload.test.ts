import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "../http.js";
import { PostoirError } from "../errors.js";
import { uploadMedia } from "../upload.js";

const png = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3, 8, 2, 0, 0,
  0,
]);

async function fixture(data = png) {
  const directory = await mkdtemp(join(tmpdir(), "postoir-upload-test-"));
  const path = join(directory, "sample.png");
  await writeFile(path, data);
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const instance = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  return {
    instance,
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        instance.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("uploads image bytes directly to storage without API credentials and uses real dimensions", async () => {
  const file = await fixture();
  let storageHeaders: Record<string, string | string[] | undefined> = {};
  let storageBytes = 0;
  let finalized: Record<string, unknown> | undefined;
  const storage = await server((request, response) => {
    storageHeaders = request.headers;
    request.on("data", (part) => {
      storageBytes += part.length;
    });
    request.on("end", () => {
      response.writeHead(200).end();
    });
  });
  const api = await server((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (part) => chunks.push(part));
    request.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      if (request.method === "POST" && request.url === "/api/v1/media/uploads")
        response.end(
          JSON.stringify({
            data: {
              ticketId: "ticket-1",
              uploadUrl: `${storage.origin}/signed`,
              size: png.length,
              mimeType: "image/png",
            },
          }),
        );
      else if (request.method === "POST" && request.url === "/api/v1/media") {
        finalized = body;
        response.end(JSON.stringify({ data: { id: "media-1" } }));
      } else response.writeHead(404).end();
    });
  });
  try {
    const client = new Client({ apiUrl: api.origin, apiKey: "top-secret" });
    await uploadMedia(client, file.path, { title: "Actual dimensions", width: 999, height: 999 });
    assert.equal(storageBytes, png.length);
    assert.equal(storageHeaders.authorization, undefined);
    assert.equal(storageHeaders["content-type"], "image/png");
    assert.equal(storageHeaders["content-length"], String(png.length));
    assert.deepEqual(finalized, {
      uploadTicket: "ticket-1",
      title: "Actual dimensions",
      width: 2,
      height: 3,
    });
  } finally {
    await Promise.all([file.cleanup(), api.close(), storage.close()]);
  }
});

test("cancels its ticket after a failed storage PUT and keeps the ticket in the error", async () => {
  const file = await fixture();
  let cancelled = false;
  const storage = await server((_request, response) => response.writeHead(500).end());
  const api = await server((request, response) => {
    if (request.method === "POST" && request.url === "/api/v1/media/uploads")
      response.end(
        JSON.stringify({
          data: {
            ticketId: "ticket-2",
            uploadUrl: `${storage.origin}/signed`,
            size: png.length,
            mimeType: "image/png",
          },
        }),
      );
    else if (request.method === "DELETE" && request.url === "/api/v1/media/uploads/ticket-2") {
      cancelled = true;
      response.writeHead(204).end();
    } else response.writeHead(404).end();
  });
  try {
    await assert.rejects(
      uploadMedia(new Client({ apiUrl: api.origin, apiKey: "secret" }), file.path),
      (error: PostoirError) =>
        error.code === "UPLOAD_FAILED" &&
        (error.details as { ticketId?: string }).ticketId === "ticket-2",
    );
    assert.equal(cancelled, true);
  } finally {
    await Promise.all([file.cleanup(), api.close(), storage.close()]);
  }
});

test("rejects a reservation whose size differs from the immutable local stat", async () => {
  const file = await fixture();
  let storageCalled = false;
  const api = await server((request, response) => {
    if (request.method === "POST")
      response.end(
        JSON.stringify({
          data: {
            ticketId: "ticket-3",
            uploadUrl: "http://127.0.0.1:1/signed",
            size: png.length + 1,
            mimeType: "image/png",
          },
        }),
      );
    else response.writeHead(404).end();
  });
  try {
    await assert.rejects(
      uploadMedia(new Client({ apiUrl: api.origin, apiKey: "secret" }), file.path),
      (error: PostoirError) => error.code === "UPLOAD_INVALID",
    );
    assert.equal(storageCalled, false);
  } finally {
    await Promise.all([file.cleanup(), api.close()]);
  }
});

test("rejects an oversized file before creating a reservation", async () => {
  const file = await fixture();
  await truncate(file.path, 100 * 1024 * 1024 + 1);
  let called = false;
  const api = await server((_request, response) => {
    called = true;
    response.writeHead(500).end();
  });
  try {
    await assert.rejects(
      uploadMedia(new Client({ apiUrl: api.origin, apiKey: "secret" }), file.path),
      (error: PostoirError) => error.code === "FILE_TOO_LARGE",
    );
    assert.equal(called, false);
  } finally {
    await Promise.all([file.cleanup(), api.close()]);
  }
});

test(
  "uses explicit video metadata when ffprobe is unavailable",
  { concurrency: false },
  async () => {
    const file = await fixture(Buffer.from("not a real mp4"));
    const videoPath = file.path.replace(/\.png$/, ".mp4");
    await writeFile(videoPath, Buffer.from("not a real mp4"));
    let finalized: Record<string, unknown> | undefined;
    const oldPath = process.env.PATH;
    process.env.PATH = "";
    const storage = await server((_request, response) => response.writeHead(200).end());
    const api = await server((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (part) => chunks.push(part));
      request.on("end", () => {
        if (request.method === "POST" && request.url === "/api/v1/media/uploads")
          response.end(
            JSON.stringify({
              data: {
                ticketId: "ticket-4",
                uploadUrl: `${storage.origin}/signed`,
                size: 14,
                mimeType: "video/mp4",
              },
            }),
          );
        else if (request.method === "POST") {
          finalized = JSON.parse(Buffer.concat(chunks).toString());
          response.end(JSON.stringify({ data: { id: "media-4" } }));
        } else response.writeHead(404).end();
      });
    });
    try {
      await uploadMedia(new Client({ apiUrl: api.origin, apiKey: "secret" }), videoPath, {
        width: 1920,
        height: 1080,
        duration: 4.5,
      });
      assert.deepEqual(finalized, {
        uploadTicket: "ticket-4",
        title: "sample",
        width: 1920,
        height: 1080,
        duration: 4.5,
      });
    } finally {
      process.env.PATH = oldPath;
      await Promise.all([file.cleanup(), api.close(), storage.close()]);
    }
  },
);

test(
  "requires explicit dimensions and duration when ffprobe is unavailable",
  { concurrency: false },
  async () => {
    const file = await fixture(Buffer.from("not a real mp4"));
    const videoPath = file.path.replace(/\.png$/, ".mp4");
    await writeFile(videoPath, Buffer.from("not a real mp4"));
    const oldPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await assert.rejects(
        uploadMedia(new Client({ apiUrl: "http://127.0.0.1:1", apiKey: "secret" }), videoPath),
        (error: PostoirError) => error.code === "VIDEO_METADATA_REQUIRED",
      );
    } finally {
      process.env.PATH = oldPath;
      await file.cleanup();
    }
  },
);

test("rejects an empty file before creating a reservation", async () => {
  const file = await fixture(Buffer.alloc(0));
  let called = false;
  const api = await server((_request, response) => {
    called = true;
    response.writeHead(500).end();
  });
  try {
    await assert.rejects(
      uploadMedia(new Client({ apiUrl: api.origin, apiKey: "secret" }), file.path),
      (error: PostoirError) => error.code === "INVALID_FILE",
    );
    assert.equal(called, false);
  } finally {
    await Promise.all([file.cleanup(), api.close()]);
  }
});

test("reads JPEG dimensions after large APP metadata segments", async () => {
  const app = Buffer.concat([Buffer.from([0xff, 0xe1, 0xff, 0xff]), Buffer.alloc(0xfffd)]);
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app,
    app,
    Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 7, 0, 9, 3, 1, 0, 2, 17, 1, 3, 17, 1, 0xff, 0xd9]),
  ]);
  const file = await fixture(jpeg);
  const jpegPath = file.path.replace(/\.png$/, ".jpg");
  await writeFile(jpegPath, jpeg);
  let finalized: Record<string, unknown> | undefined;
  const storage = await server((_request, response) => response.writeHead(200).end());
  const api = await server((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (part) => chunks.push(part));
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/api/v1/media/uploads")
        response.end(
          JSON.stringify({
            data: {
              ticketId: "ticket-jpeg",
              uploadUrl: `${storage.origin}/signed`,
              size: jpeg.length,
              mimeType: "image/jpeg",
            },
          }),
        );
      else if (request.method === "POST") {
        finalized = JSON.parse(Buffer.concat(chunks).toString());
        response.end(JSON.stringify({ data: { id: "media-jpeg" } }));
      } else response.writeHead(404).end();
    });
  });
  try {
    await uploadMedia(new Client({ apiUrl: api.origin, apiKey: "secret" }), jpegPath);
    assert.deepEqual(finalized, {
      uploadTicket: "ticket-jpeg",
      title: "sample",
      width: 9,
      height: 7,
    });
  } finally {
    await Promise.all([file.cleanup(), api.close(), storage.close()]);
  }
});

test("keeps the ticket and does not cancel after ambiguous finalization failure", async () => {
  const file = await fixture();
  let cancelled = false;
  const storage = await server((_request, response) => response.writeHead(200).end());
  const api = await server((request, response) => {
    if (request.method === "POST" && request.url === "/api/v1/media/uploads")
      response.end(
        JSON.stringify({
          data: {
            ticketId: "ticket-finalize",
            uploadUrl: `${storage.origin}/signed`,
            size: png.length,
            mimeType: "image/png",
          },
        }),
      );
    else if (request.method === "POST" && request.url === "/api/v1/media") response.destroy();
    else if (request.method === "DELETE") {
      cancelled = true;
      response.writeHead(204).end();
    } else response.writeHead(404).end();
  });
  try {
    await assert.rejects(
      uploadMedia(new Client({ apiUrl: api.origin, apiKey: "secret" }), file.path),
      (error: PostoirError) =>
        error.code === "NETWORK_ERROR" &&
        (error.details as { ticketId?: string }).ticketId === "ticket-finalize",
    );
    assert.equal(cancelled, false);
  } finally {
    await Promise.all([file.cleanup(), api.close(), storage.close()]);
  }
});

test("cancels the reservation when the local stream cannot be opened", async () => {
  const file = await fixture();
  let cancelled = false;
  const storage = await server((_request, response) => response.writeHead(200).end());
  const api = await server((request, response) => {
    if (request.method === "POST" && request.url === "/api/v1/media/uploads") {
      rm(file.path, { force: true }).then(() =>
        response.end(
          JSON.stringify({
            data: {
              ticketId: "ticket-read",
              uploadUrl: `${storage.origin}/signed`,
              size: png.length,
              mimeType: "image/png",
            },
          }),
        ),
      );
    } else if (request.method === "DELETE") {
      cancelled = true;
      response.writeHead(204).end();
    } else response.writeHead(404).end();
  });
  try {
    await assert.rejects(
      uploadMedia(new Client({ apiUrl: api.origin, apiKey: "secret" }), file.path),
      (error: PostoirError) => (error.details as { ticketId?: string }).ticketId === "ticket-read",
    );
    assert.equal(cancelled, true);
  } finally {
    await Promise.all([file.cleanup(), api.close(), storage.close()]);
  }
});
