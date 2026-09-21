#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "./http.js";
import { Operations } from "./operations.js";
import { credentials } from "./config.js";
import { PostoirError, safeMessage } from "./errors.js";

type Json = Record<string, unknown>;
type RpcId = string | number | null;
type RpcRequest = { jsonrpc?: unknown; id?: RpcId; method?: unknown; params?: unknown };
type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations: Json;
};

const PROTOCOL_VERSION = "2024-11-05";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const platforms = [
  "FACEBOOK",
  "LINKEDIN",
  "TWITTER",
  "INSTAGRAM",
  "TIKTOK",
  "DISCORD",
  "YOUTUBE",
  "YOUTUBE_SHORTS",
  "YOUTUBE_POSTS",
  "REDDIT",
  "TELEGRAM",
  "PINTEREST",
  "QUORA",
  "COINMARKETCAP",
  "KWAI",
];

const statuses = [
  "DRAFT",
  "VARIANT",
  "NEED_REVIEW",
  "READY_TO_PUBLISH",
  "SCHEDULED",
  "PUBLISHED",
  "ARCHIVED",
];

const languages = ["EN", "FR", "ES", "DE", "IT", "PT", "RU", "ZH"];

const mediaMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
];

const string = (description?: string, extra: Json = {}): Json => ({
  type: "string",
  ...(description ? { description } : {}),
  ...extra,
});

const number = (description?: string, extra: Json = {}): Json => ({
  type: "number",
  ...(description ? { description } : {}),
  ...extra,
});

const object = (properties: Json, required: string[] = [], extra: Json = {}): Json => ({
  type: "object",
  properties,
  additionalProperties: false,
  ...(required.length ? { required } : {}),
  ...extra,
});

const uuid = (description?: string): Json => string(description, { format: "uuid" });
const nullableText = (maximum: number, description: string): Json => ({
  anyOf: [string(description, { maxLength: maximum }), { type: "null" }],
});

const pagination = {
  page: number("Page number, starting at 1", { type: "integer", minimum: 1, default: 1 }),
  perPage: number("Results per page, at most 100", {
    type: "integer",
    minimum: 1,
    maximum: 100,
    default: 20,
  }),
};

const editableFields: Json = {
  campaignId: {
    anyOf: [
      uuid("Optional campaign ID from list_campaigns; null detaches the campaign"),
      { type: "null" },
    ],
  },
  title: nullableText(200, "Post title; null clears it"),
  summary: nullableText(5_000, "Post summary; null clears it"),
  content: nullableText(20_000, "Post body; null clears it"),
  tags: { type: "array", items: string(undefined, { minLength: 1, maxLength: 100 }), maxItems: 30 },
  language: { type: "string", enum: languages },
  fullPrompt: nullableText(20_000, "Original generation prompt; null clears it"),
  negativePrompt: nullableText(20_000, "Negative generation prompt; null clears it"),
  mediaGenerationPrompt: nullableText(20_000, "Media generation prompt; null clears it"),
  socialAccountIds: {
    type: "array",
    items: uuid(),
    maxItems: 50,
    description: "Target account IDs from list_social_accounts",
  },
  mediaIds: {
    type: "array",
    items: uuid(),
    maxItems: 50,
    description: "Media IDs from list_media",
  },
};

const readOnly = { readOnlyHint: true, openWorldHint: true };
const write = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const tools: Tool[] = [
  {
    name: "get_organization",
    title: "Get the current Postoir workspace",
    description: "Return details about the current Postoir workspace.",
    inputSchema: object({}),
    annotations: readOnly,
  },
  {
    name: "list_posts",
    title: "List Postoir posts",
    description: "List posts with pagination and optional filters.",
    inputSchema: object({
      ...pagination,
      search: string(undefined, { maxLength: 200 }),
      status: { type: "string", enum: statuses },
      platform: { type: "string", enum: platforms },
      campaignId: uuid(),
    }),
    annotations: readOnly,
  },
  {
    name: "get_post",
    title: "Get a Postoir post",
    description: "Return a post from the current Postoir workspace.",
    inputSchema: object({ postId: uuid() }, ["postId"]),
    annotations: readOnly,
  },
  {
    name: "create_draft_post",
    title: "Create a Postoir draft",
    description:
      "Create a draft without publishing or scheduling it. Reuse idempotencyKey only when retrying the same creation.",
    inputSchema: object({
      ...editableFields,
      language: { type: "string", enum: languages, default: "EN" },
      idempotencyKey: string("Stable retry key. A UUID is generated when omitted.", {
        minLength: 1,
        maxLength: 100,
        pattern: "^[A-Za-z0-9._:-]+$",
      }),
    }),
    annotations: write,
  },
  {
    name: "update_draft_post",
    title: "Update a Postoir draft",
    description: "Update one or more editable fields on a draft.",
    inputSchema: object({ postId: uuid(), ...editableFields }, ["postId"]),
    annotations: write,
  },
  {
    name: "delete_draft_post",
    title: "Delete a Postoir post",
    description:
      "Delete a post from Postoir and cancel work that has not started. Content already published on a social network remains available there.",
    inputSchema: object({ postId: uuid() }, ["postId"]),
    annotations: destructive,
  },
  {
    name: "publish_post",
    title: "Publish a Postoir post",
    description:
      "Start publication to the selected social accounts. Acceptance does not guarantee completed delivery.",
    inputSchema: object({ postId: uuid() }, ["postId"]),
    annotations: destructive,
  },
  {
    name: "schedule_post",
    title: "Schedule a Postoir post",
    description:
      "Schedule or move a post before delivery starts. scheduledFor must be a future ISO 8601 timestamp with an explicit timezone.",
    inputSchema: object(
      { postId: uuid(), scheduledFor: string(undefined, { format: "date-time" }) },
      ["postId", "scheduledFor"],
    ),
    annotations: destructive,
  },
  {
    name: "cancel_post_schedule",
    title: "Cancel a Postoir schedule",
    description: "Cancel a schedule before delivery begins and return the post to draft.",
    inputSchema: object({ postId: uuid() }, ["postId"]),
    annotations: destructive,
  },
  {
    name: "list_campaigns",
    title: "List Postoir campaigns",
    description: "List campaigns available when creating or updating a post.",
    inputSchema: object({ ...pagination, search: string(undefined, { maxLength: 200 }) }),
    annotations: readOnly,
  },
  {
    name: "list_social_accounts",
    title: "List Postoir social accounts",
    description: "List the social accounts available for publishing.",
    inputSchema: object({ ...pagination, platform: { type: "string", enum: platforms } }),
    annotations: readOnly,
  },
  {
    name: "list_media",
    title: "List Postoir media",
    description: "List media that can be attached to a post.",
    inputSchema: object({ ...pagination, search: string(undefined, { maxLength: 200 }) }),
    annotations: readOnly,
  },
  {
    name: "upload_media",
    title: "Upload local media to Postoir",
    description:
      "Upload a supported local image or video. Video dimensions and duration are required when ffprobe is unavailable.",
    inputSchema: object(
      {
        path: string("Path to a local media file. stdin is reserved for MCP messages.", {
          minLength: 1,
          not: { const: "-" },
        }),
        title: string(undefined, { minLength: 1, maxLength: 200 }),
        summary: string(undefined, { maxLength: 5_000 }),
        mimeType: { type: "string", enum: mediaMimeTypes },
        fileName: string(undefined, { minLength: 1, maxLength: 255 }),
        width: number(undefined, { type: "integer", minimum: 1 }),
        height: number(undefined, { type: "integer", minimum: 1 }),
        duration: number(undefined, { exclusiveMinimum: 0 }),
      },
      ["path"],
    ),
    annotations: write,
  },
  {
    name: "reserve_media_upload",
    title: "Start a Postoir media upload",
    description: "Start a media upload and return the instructions needed to transfer the file.",
    inputSchema: object(
      {
        size: number(undefined, { type: "integer", minimum: 1, maximum: MAX_UPLOAD_BYTES }),
        mimeType: { type: "string", enum: mediaMimeTypes },
        fileName: string(undefined, { minLength: 1, maxLength: 255 }),
      },
      ["size", "mimeType"],
    ),
    annotations: { ...write, idempotentHint: false },
  },
  {
    name: "finalize_media_upload",
    title: "Complete a Postoir media upload",
    description:
      "Complete an uploaded file and create reusable Postoir media. Retrying the same upload returns the same result.",
    inputSchema: object(
      {
        uploadTicket: uuid(),
        title: string(undefined, { minLength: 1, maxLength: 200 }),
        summary: string(undefined, { maxLength: 5_000 }),
        width: number(undefined, { type: "integer", minimum: 0 }),
        height: number(undefined, { type: "integer", minimum: 0 }),
        duration: number(undefined, { minimum: 0 }),
      },
      ["uploadTicket", "title", "width", "height"],
    ),
    annotations: write,
  },
  {
    name: "cancel_media_upload",
    title: "Cancel a Postoir media upload",
    description: "Cancel an upload that is no longer needed.",
    inputSchema: object({ ticketId: uuid() }, ["ticketId"]),
    annotations: destructive,
  },
];

function send(message: Json): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorBody(error: unknown): Json {
  const value =
    error instanceof PostoirError
      ? error
      : new PostoirError("MCP_INTERNAL_ERROR", safeMessage(error));
  const withKey = value as PostoirError & { idempotencyKey?: string };
  return {
    error: {
      code: value.code,
      message: safeMessage(value.message),
      ...(value.requestId ? { requestId: value.requestId } : {}),
      ...(value.details === undefined ? {} : { details: value.details }),
      ...(withKey.idempotencyKey ? { idempotencyKey: withKey.idempotencyKey } : {}),
    },
  };
}

function toolError(error: unknown): Json {
  const body = errorBody(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

function toolSuccess(value: unknown): Json {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function invalid(message: string): never {
  throw new PostoirError("INVALID_ARGUMENT", message);
}

function requireString(args: Json, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value) invalid(`${key} must be a non-empty string`);
  return value;
}

function ensureNoUnknown(args: Json, allowed: string[]): void {
  for (const key of Object.keys(args))
    if (!allowed.includes(key)) invalid(`Unknown argument: ${key}`);
}

function optionalFilters(args: Json, allowed: string[]): Record<string, string> {
  ensureNoUnknown(args, allowed);
  const output: Record<string, string> = {};
  for (const key of allowed) {
    const value = args[key];
    if (value !== undefined) {
      if (typeof value !== "string" && typeof value !== "number")
        invalid(`${key} must be a string or number`);
      output[key] = String(value);
    }
  }
  return output;
}

function validate(name: string, args: Json): void {
  const editable = Object.keys(editableFields);
  if (name === "get_organization") return ensureNoUnknown(args, []);
  if (name === "list_posts")
    return void optionalFilters(args, [
      "search",
      "status",
      "platform",
      "campaignId",
      "page",
      "perPage",
    ]);
  if (name === "list_campaigns" || name === "list_media")
    return void optionalFilters(args, ["search", "page", "perPage"]);
  if (name === "list_social_accounts")
    return void optionalFilters(args, ["platform", "page", "perPage"]);
  if (["get_post", "delete_draft_post", "publish_post", "cancel_post_schedule"].includes(name)) {
    ensureNoUnknown(args, ["postId"]);
    requireString(args, "postId");
    return;
  }
  if (name === "schedule_post") {
    ensureNoUnknown(args, ["postId", "scheduledFor"]);
    requireString(args, "postId");
    const at = requireString(args, "scheduledFor");
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(at) ||
      Number.isNaN(Date.parse(at))
    )
      invalid("scheduledFor must be an ISO 8601 timestamp with timezone");
    return;
  }
  if (name === "create_draft_post") {
    ensureNoUnknown(args, [...editable, "idempotencyKey"]);
    if (
      args.idempotencyKey !== undefined &&
      (typeof args.idempotencyKey !== "string" ||
        !/^[A-Za-z0-9._:-]{1,100}$/.test(args.idempotencyKey))
    )
      invalid("idempotencyKey is invalid");
    return;
  }
  if (name === "update_draft_post") {
    ensureNoUnknown(args, ["postId", ...editable]);
    requireString(args, "postId");
    if (!editable.some((key) => Object.hasOwn(args, key)))
      invalid("At least one editable field is required");
    return;
  }
  if (name === "upload_media") {
    ensureNoUnknown(args, [
      "path",
      "title",
      "summary",
      "mimeType",
      "fileName",
      "width",
      "height",
      "duration",
    ]);
    if (requireString(args, "path") === "-")
      invalid("upload_media requires a local file path; stdin carries MCP messages");
    return;
  }
  if (name === "reserve_media_upload") {
    ensureNoUnknown(args, ["size", "mimeType", "fileName"]);
    if (
      !Number.isInteger(args.size) ||
      (args.size as number) < 1 ||
      (args.size as number) > MAX_UPLOAD_BYTES
    )
      invalid("size must be an integer between 1 and 104857600");
    if (typeof args.mimeType !== "string" || !mediaMimeTypes.includes(args.mimeType))
      invalid("mimeType is unsupported");
    return;
  }
  if (name === "finalize_media_upload") {
    ensureNoUnknown(args, ["uploadTicket", "title", "summary", "width", "height", "duration"]);
    for (const key of ["uploadTicket", "title"]) requireString(args, key);
    for (const key of ["width", "height"])
      if (!Number.isInteger(args[key]) || (args[key] as number) < 0)
        invalid(`${key} must be a non-negative integer`);
    return;
  }
  if (name === "cancel_media_upload") {
    ensureNoUnknown(args, ["ticketId"]);
    requireString(args, "ticketId");
    return;
  }
  invalid("Unknown tool");
}

async function invoke(name: string, args: Json): Promise<unknown> {
  validate(name, args);
  const configured = await credentials(process.env.POSTOIR_PROFILE);
  const apiUrl = process.env.POSTOIR_API_URL || configured.value.apiUrl;
  const ops = new Operations(new Client({ ...configured.value, apiUrl }));
  if (name === "get_organization") return ops.organization();
  if (name === "list_posts")
    return ops.posts(
      false,
      optionalFilters(args, ["search", "status", "platform", "campaignId", "page", "perPage"]),
    );
  if (name === "get_post") return ops.post(requireString(args, "postId"));
  if (name === "create_draft_post") {
    const { idempotencyKey, ...data } = args;
    return ops.createPost(
      data,
      String(typeof idempotencyKey === "string" ? idempotencyKey : randomUUID()),
    );
  }
  if (name === "update_draft_post") {
    const { postId, ...data } = args;
    return ops.updatePost(String(postId), data);
  }
  if (name === "delete_draft_post") {
    const postId = requireString(args, "postId");
    await ops.deletePost(postId);
    return { deleted: true, postId };
  }
  if (name === "publish_post") {
    const result = await ops.publishWithReconciliation(requireString(args, "postId"));
    if (isRecord(result) && result.accepted === false)
      throw new PostoirError(
        "PUBLICATION_NOT_ACCEPTED",
        "Post publication was not accepted",
        undefined,
        undefined,
        result,
      );
    return result;
  }
  if (name === "schedule_post")
    return ops.schedule(requireString(args, "postId"), requireString(args, "scheduledFor"));
  if (name === "cancel_post_schedule") return ops.unschedule(requireString(args, "postId"));
  if (name === "list_campaigns")
    return ops.campaigns(false, optionalFilters(args, ["search", "page", "perPage"]));
  if (name === "list_social_accounts")
    return ops.accounts(false, optionalFilters(args, ["platform", "page", "perPage"]));
  if (name === "list_media")
    return ops.media(false, optionalFilters(args, ["search", "page", "perPage"]));
  if (name === "upload_media") {
    const { path, ...metadata } = args;
    return ops.upload(String(path), metadata);
  }
  if (name === "reserve_media_upload")
    return ops.reserveMediaUpload(args as { size: number; mimeType: string; fileName?: string });
  if (name === "finalize_media_upload")
    return ops.finalizeMediaUpload(
      args as {
        uploadTicket: string;
        title: string;
        summary?: string;
        width: number;
        height: number;
        duration?: number;
      },
    );
  if (name === "cancel_media_upload") {
    const ticketId = requireString(args, "ticketId");
    await ops.cancelMediaUpload(ticketId);
    return { cancelled: true, ticketId };
  }
  invalid("Unknown tool");
}

async function handle(message: RpcRequest): Promise<void> {
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    if (message.id !== undefined)
      send({
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
    return;
  }
  const notification = message.id === undefined;
  if (
    message.method === "notifications/initialized" ||
    message.method === "notifications/cancelled"
  )
    return;
  if (message.method === "initialize") {
    if (!notification)
      send({
        jsonrpc: "2.0",
        id: message.id!,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "postoir", version: "0.1.0" },
          instructions:
            "Use Postoir to find the right accounts, prepare drafts, attach media, publish or schedule, and verify delivery.",
        },
      });
    return;
  }
  if (message.method === "ping") {
    if (!notification) send({ jsonrpc: "2.0", id: message.id!, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    if (!notification) send({ jsonrpc: "2.0", id: message.id!, result: { tools } });
    return;
  }
  if (message.method !== "tools/call") {
    if (!notification)
      send({
        jsonrpc: "2.0",
        id: message.id!,
        error: { code: -32601, message: "Method not found" },
      });
    return;
  }
  if (notification) return;
  const params = message.params;
  if (
    !isRecord(params) ||
    typeof params.name !== "string" ||
    (params.arguments !== undefined && !isRecord(params.arguments))
  ) {
    if (!notification)
      send({ jsonrpc: "2.0", id: message.id!, error: { code: -32602, message: "Invalid params" } });
    return;
  }
  if (!tools.some((tool) => tool.name === params.name)) {
    if (!notification)
      send({
        jsonrpc: "2.0",
        id: message.id!,
        result: toolError(new PostoirError("UNKNOWN_TOOL", "Unknown tool")),
      });
    return;
  }
  try {
    const result = await invoke(params.name, (params.arguments as Json | undefined) ?? {});
    if (!notification) send({ jsonrpc: "2.0", id: message.id!, result: toolSuccess(result) });
  } catch (error) {
    if (!notification) send({ jsonrpc: "2.0", id: message.id!, result: toolError(error) });
  }
}

export async function runMcp(): Promise<void> {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += String(chunk);
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed))
          send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
        else await handle(parsed);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === resolve(invokedPath)) void runMcp();
