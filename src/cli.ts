#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { stdin } from "node:process";
import { spawnSync } from "node:child_process";
import { Client } from "./http.js";
import { Operations, type WatchResult } from "./operations.js";
import { credentials, listProfiles, removeProfile, setProfile, useProfile } from "./config.js";
import { PostoirError, safeMessage } from "./errors.js";
import { installSkill } from "./skills.js";
import { runMcp } from "./mcp.js";

type Args = { _: string[]; [key: string]: string | string[] | boolean | undefined };
const globalOptions = new Set(["json", "api-url", "profile", "timeout", "all", "help"]);
const booleanOptions = new Set(["json", "all", "help"]);
const knownOptions = new Set([
  ...globalOptions,
  "api-key",
  "dir",
  "search",
  "status",
  "platform",
  "page",
  "per-page",
  "content-type",
  "title",
  "width",
  "height",
  "duration",
  "data",
  "content-file",
  "content",
  "summary",
  "campaign",
  "language",
  "tags",
  "full-prompt",
  "negative-prompt",
  "media-generation-prompt",
  "account",
  "media",
  "idempotency-key",
  "at",
  "interval",
]);
const exits: Record<string, number> = {
  USAGE: 2,
  INVALID_ARGUMENT: 2,
  INVALID_SCHEDULE: 2,
  INVALID_DEADLINE: 2,
  AUTH_REQUIRED: 3,
  FORBIDDEN: 4,
  RATE_LIMITED: 5,
};

function parse(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    const name = equal < 0 ? token.slice(2) : token.slice(2, equal);
    const inline = equal < 0 ? undefined : token.slice(equal + 1);
    if (!name || args[name] !== undefined)
      throw new PostoirError(
        "USAGE",
        !name ? "Empty option name" : `Option --${name} was supplied more than once`,
      );
    if (!knownOptions.has(name)) throw new PostoirError("USAGE", `Unknown option --${name}`);
    if (inline !== undefined) {
      args[name] = inline;
      continue;
    }
    if (booleanOptions.has(name)) {
      args[name] = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--"))
      throw new PostoirError("USAGE", `Option --${name} requires a value`);
    args[name] = next;
    index++;
  }
  return args;
}

function value(args: Args, name: string): string | undefined {
  return typeof args[name] === "string" ? args[name] : undefined;
}

function requireValue(raw: string | undefined, name: string): string {
  if (!raw) throw new PostoirError("INVALID_ARGUMENT", `${name} is required`);
  return raw;
}

function integer(args: Args, name: string): number | undefined {
  const raw = value(args, name);
  if (raw === undefined) return;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new PostoirError("INVALID_ARGUMENT", `--${name} must be a positive integer`);
  return parsed;
}

function options(args: Args, allowed: string[]): void {
  for (const name of Object.keys(args))
    if (name !== "_" && !globalOptions.has(name) && !allowed.includes(name))
      throw new PostoirError("USAGE", `Unknown option --${name}`);
}

async function readText(path: string): Promise<string> {
  if (path !== "-") return readFile(path, "utf8");
  let text = "";
  stdin.setEncoding("utf8");
  for await (const part of stdin) text += part;
  return text;
}

function print(result: unknown, json: boolean): void {
  process.stdout.write(
    json
      ? `${JSON.stringify(result)}\n`
      : `${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`,
  );
}

function usage(): string {
  return `Usage: postoir [--json --api-url URL --profile NAME --timeout MS --all] COMMAND\n\nCommands:\n  auth login [--api-key KEY] [--profile NAME] | auth status | auth logout\n  profiles list | profiles use NAME | doctor | organization get\n  accounts list | campaigns list | media list | media upload FILE\n  posts list|get|create|update|delete|publish|schedule|unschedule|watch\n  skills list | skills install [claude|cursor] [--dir PATH]\n  mcp serve | mcp config [claude|cursor]\n\nExamples:\n  printf '%s' "$POSTOIR_API_KEY" | postoir auth login --profile production\n  postoir posts create --account ACCOUNT_ID --content "Draft copy" --idempotency-key launch-001\n  postoir posts schedule POST_ID --at 2030-01-15T09:00:00+01:00`;
}

async function postData(args: Args): Promise<Record<string, unknown>> {
  const data = value(args, "data"),
    contentFile = value(args, "content-file");
  if (data && contentFile)
    throw new PostoirError("INVALID_ARGUMENT", "Use either --data or --content-file");
  if (data) {
    try {
      const result: unknown = JSON.parse(await readText(data));
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
      return result as Record<string, unknown>;
    } catch {
      throw new PostoirError("INVALID_ARGUMENT", "--data must be a JSON object");
    }
  }
  const result: Record<string, unknown> = {};
  const content = contentFile ? await readText(contentFile) : value(args, "content");
  if (content !== undefined) result.content = content;
  const mapping: Record<string, string> = {
    title: "title",
    summary: "summary",
    campaign: "campaignId",
    language: "language",
    "full-prompt": "fullPrompt",
    "negative-prompt": "negativePrompt",
    "media-generation-prompt": "mediaGenerationPrompt",
  };
  for (const [flag, field] of Object.entries(mapping)) {
    const raw = value(args, flag);
    if (raw !== undefined) result[field] = raw;
  }
  const tags = value(args, "tags");
  if (tags !== undefined)
    result.tags = tags
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  for (const [flag, field] of [
    ["account", "socialAccountIds"],
    ["media", "mediaIds"],
  ] as const) {
    const raw = value(args, flag);
    if (raw !== undefined)
      result[field] = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  }
  return result;
}

function filters(
  args: Args,
  pairs: ReadonlyArray<readonly [string, string]>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [flag, field] of pairs) {
    const raw = value(args, flag);
    if (raw !== undefined) {
      if (flag === "page" || flag === "per-page") integer(args, flag);
      result[field] = raw;
    }
  }
  return result;
}

function outcome(result: WatchResult): number {
  if (result.timedOut) return 8;
  if (result.publications.some((item) => item.status === "RECONCILIATION_REQUIRED")) return 7;
  return result.publications.some((item) => item.status === "FAILED") ? 6 : 0;
}

function ffprobeDiagnostic(): { available: boolean; message: string } {
  const probe = spawnSync("ffprobe", ["-version"], { stdio: "ignore" });
  return probe.status === 0
    ? { available: true, message: "ffprobe is available for local video metadata inspection." }
    : {
        available: false,
        message:
          "ffprobe was not found; install FFmpeg to inspect local video metadata before upload.",
      };
}

async function main(): Promise<void> {
  let args: Args = { _: [] };
  let json = process.argv.includes("--json");
  let group: string | undefined, action: string | undefined, identifier: string | undefined;
  try {
    args = parse(process.argv.slice(2));
    json = args.json === true;
    [group, action, identifier] = args._;
    if (args.help || !group) {
      options(args, []);
      print(usage(), false);
      return;
    }
    options(args, [
      "api-key",
      "dir",
      "search",
      "status",
      "platform",
      "page",
      "per-page",
      "content-type",
      "title",
      "width",
      "height",
      "duration",
      "data",
      "content-file",
      "content",
      "summary",
      "campaign",
      "language",
      "tags",
      "full-prompt",
      "negative-prompt",
      "media-generation-prompt",
      "account",
      "media",
      "idempotency-key",
      "at",
      "interval",
    ]);
    if (group === "auth" && action === "login") {
      options(args, ["api-key"]);
      const apiKey =
        value(args, "api-key") || (!stdin.isTTY ? (await readText("-")).trim() : undefined);
      if (!apiKey)
        throw new PostoirError(
          "INVALID_ARGUMENT",
          "Provide --api-key or pipe a key on standard input",
        );
      await setProfile(value(args, "profile") || "default", {
        apiKey,
        apiUrl: value(args, "api-url") || "https://postoir.com",
      });
      print(
        json
          ? { ok: true }
          : "Credentials stored. Prefer stdin or POSTOIR_API_KEY to avoid shell history.",
        json,
      );
      return;
    }
    if (group === "auth" && action === "logout") {
      options(args, []);
      await removeProfile(value(args, "profile"));
      print({ ok: true }, json);
      return;
    }
    if (group === "profiles") {
      options(args, []);
      if (action === "list") {
        print(await listProfiles(), json);
        return;
      }
      if (action === "use") {
        await useProfile(requireValue(identifier, "Profile name"));
        print({ ok: true }, json);
        return;
      }
    }
    if (group === "skills") {
      options(args, ["dir"]);
      if (action === "list") {
        print({ skills: ["postoir"], targets: ["claude", "cursor"] }, json);
        return;
      }
      if (action === "install") {
        print(await installSkill(identifier, value(args, "dir")), json);
        return;
      }
    }
    if (group === "mcp" && action === "config") {
      options(args, []);
      const target = identifier || "claude";
      if (target !== "claude" && target !== "cursor")
        throw new PostoirError("INVALID_ARGUMENT", "mcp config target must be claude or cursor");
      const env: Record<string, string> = {};
      if (value(args, "api-url")) env.POSTOIR_API_URL = value(args, "api-url")!;
      if (value(args, "profile")) env.POSTOIR_PROFILE = value(args, "profile")!;
      print(
        {
          mcpServers: {
            postoir: {
              command: "postoir",
              args: ["mcp", "serve"],
              ...(Object.keys(env).length ? { env } : {}),
            },
          },
        },
        true,
      );
      return;
    }
    if (group === "mcp" && action === "serve") {
      options(args, []);
      if (value(args, "api-url")) process.env.POSTOIR_API_URL = value(args, "api-url");
      if (value(args, "profile")) process.env.POSTOIR_PROFILE = value(args, "profile");
      await runMcp();
      return;
    }
    const credential = await credentials(value(args, "profile"));
    const timeout = integer(args, "timeout");
    const apiUrl = value(args, "api-url") || credential.value.apiUrl;
    const ops = new Operations(new Client({ ...credential.value, apiUrl, timeout }));
    if (group === "auth" && action === "status") {
      options(args, []);
      print(
        {
          configured: true,
          verified: true,
          profile: credential.profile,
          apiUrl,
          organization: await ops.organization(),
        },
        json,
      );
      return;
    }
    if (group === "doctor") {
      options(args, []);
      const ffprobe = ffprobeDiagnostic();
      print(
        {
          ok: true,
          connectivity: "verified",
          profile: credential.profile,
          apiUrl,
          organization: await ops.organization(),
          ffprobe,
        },
        json,
      );
      return;
    }
    if (group === "organization" && action === "get") {
      options(args, []);
      print(await ops.organization(), json);
      return;
    }
    if (["accounts", "campaigns", "media"].includes(group) && action === "list") {
      options(args, ["search", "platform", "page", "per-page"]);
      const query = filters(args, [
        ["search", "search"],
        ["platform", "platform"],
        ["page", "page"],
        ["per-page", "perPage"],
      ]);
      print(
        await (group === "accounts"
          ? ops.accounts(!!args.all, query)
          : group === "campaigns"
            ? ops.campaigns(!!args.all, query)
            : ops.media(!!args.all, query)),
        json,
      );
      return;
    }
    if (group === "media" && action === "upload") {
      options(args, ["content-type", "title", "width", "height", "duration"]);
      const durationRaw = value(args, "duration");
      const duration = durationRaw === undefined ? undefined : Number(durationRaw);
      if (duration !== undefined && (!Number.isFinite(duration) || duration < 0))
        throw new PostoirError("INVALID_ARGUMENT", "--duration must be non-negative");
      print(
        await ops.upload(requireValue(identifier, "Media file path"), {
          mimeType: value(args, "content-type"),
          title: value(args, "title"),
          width: integer(args, "width"),
          height: integer(args, "height"),
          duration,
        }),
        json,
      );
      return;
    }
    if (group === "posts") {
      const writable = [
        "data",
        "content-file",
        "content",
        "title",
        "summary",
        "campaign",
        "language",
        "tags",
        "full-prompt",
        "negative-prompt",
        "media-generation-prompt",
        "account",
        "media",
      ];
      if (action === "list") {
        options(args, ["search", "status", "platform", "campaign", "page", "per-page"]);
        print(
          await ops.posts(
            !!args.all,
            filters(args, [
              ["search", "search"],
              ["status", "status"],
              ["platform", "platform"],
              ["campaign", "campaignId"],
              ["page", "page"],
              ["per-page", "perPage"],
            ]),
          ),
          json,
        );
        return;
      }
      if (["get", "delete", "publish", "unschedule"].includes(action || "")) {
        options(args, []);
        const id = requireValue(identifier, "Post ID");
        const result =
          action === "get"
            ? await ops.post(id)
            : action === "delete"
              ? await ops.deletePost(id)
              : action === "publish"
                ? await ops.publishWithReconciliation(id)
                : await ops.unschedule(id);
        if (action === "publish" && (result as { accepted?: boolean }).accepted === false) {
          print(result, json);
          process.exitCode = 1;
          return;
        }
        print(
          result === undefined && action === "delete" ? { deleted: true, postId: id } : result,
          json,
        );
        return;
      }
      if (action === "create") {
        options(args, [...writable, "idempotency-key"]);
        print(await ops.createPost(await postData(args), value(args, "idempotency-key")), json);
        return;
      }
      if (action === "update") {
        options(args, writable);
        const body = await postData(args);
        if (!Object.keys(body).length)
          throw new PostoirError(
            "INVALID_ARGUMENT",
            "Supply at least one editable field for update",
          );
        print(await ops.updatePost(requireValue(identifier, "Post ID"), body), json);
        return;
      }
      if (action === "schedule") {
        options(args, ["at"]);
        const result = await ops.schedule(
          requireValue(identifier, "Post ID"),
          requireValue(value(args, "at"), "--at"),
        );
        if (json) print(result, true);
        else {
          const post =
            (result as { data?: Record<string, unknown> }).data ||
            (result as Record<string, unknown>);
          const targets = Array.isArray(post.publications) ? post.publications : [];
          print(
            `Scheduled for ${String(post.scheduledFor)}\nTargets: ${targets.map((target) => String((target as Record<string, unknown>).socialAccountId || "unknown")).join(", ") || "none returned"}`,
            false,
          );
        }
        return;
      }
      if (action === "watch") {
        options(args, ["interval"]);
        const result = await ops.watch(requireValue(identifier, "Post ID"), {
          timeoutMs: timeout,
          intervalMs: integer(args, "interval"),
          onUpdate: json
            ? undefined
            : (update) =>
                process.stderr.write(
                  `Delivery update: ${update.publications.map((item) => `${item.socialAccountId || item.platform || "target"}=${item.status}`).join(", ") || "waiting"}\n`,
                ),
        });
        print(result, json);
        process.exitCode = outcome(result);
        return;
      }
    }
    throw new PostoirError("USAGE", "Unknown command. Run `postoir --help`.");
  } catch (error) {
    const err =
      error instanceof PostoirError ? error : new PostoirError("UNEXPECTED", safeMessage(error));
    const withKey = err as PostoirError & { idempotencyKey?: string };
    const payload = {
      error: {
        code: err.code,
        message: safeMessage(err.message),
        requestId: err.requestId,
        details: err.details,
        idempotencyKey: withKey.idempotencyKey,
      },
    };
    process.stderr.write(
      json
        ? `${JSON.stringify(payload)}\n`
        : `${payload.error.code}: ${payload.error.message}${err.requestId ? ` (request ${err.requestId})` : ""}${withKey.idempotencyKey ? ` (creation key ${withKey.idempotencyKey})` : ""}\n`,
    );
    process.exitCode = exits[err.code] || (err.status === 403 ? 4 : err.status === 429 ? 5 : 1);
  }
}

void main();
