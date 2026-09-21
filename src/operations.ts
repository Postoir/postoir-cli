import { randomUUID } from "node:crypto";
import { Client, collectPages } from "./http.js";
import { PostoirError } from "./errors.js";
import { uploadMedia } from "./upload.js";

const enc = encodeURIComponent;

export class Operations {
  constructor(readonly client: Client) {}

  organization() {
    return this.client.get("/api/v1/organization");
  }

  accounts(all = false, filters: Record<string, string> = {}) {
    return this.list("/api/v1/social-accounts", all, filters);
  }

  campaigns(all = false, filters: Record<string, string> = {}) {
    return this.list("/api/v1/campaigns", all, filters);
  }

  media(all = false, filters: Record<string, string> = {}) {
    return this.list("/api/v1/media", all, filters);
  }

  private list(path: string, all: boolean, filters: Record<string, string>) {
    const query = new URLSearchParams(filters).toString();
    const url = `${path}${query ? `?${query}` : ""}`;
    return all ? collectPages(url, this.client, true) : this.client.get(url);
  }

  reserveMediaUpload(input: { size: number; mimeType: string; fileName?: string }) {
    return this.client.request("POST", "/api/v1/media/uploads", input);
  }

  finalizeMediaUpload(input: {
    uploadTicket: string;
    title: string;
    summary?: string;
    width: number;
    height: number;
    duration?: number;
  }) {
    return this.client.request("POST", "/api/v1/media", input);
  }

  cancelMediaUpload(ticketId: string) {
    return this.client.request("DELETE", `/api/v1/media/uploads/${enc(ticketId)}`);
  }

  posts(all = false, filters: Record<string, string> = {}) {
    const allowed = ["search", "status", "platform", "campaignId", "page", "perPage"];
    const q = new URLSearchParams(
      Object.entries(filters).filter(([k]) => allowed.includes(k)),
    ).toString();
    const path = `/api/v1/posts${q ? `?${q}` : ""}`;
    return all ? collectPages(path, this.client, true) : this.client.get(path);
  }

  post(id: string) {
    return this.client.get(`/api/v1/posts/${enc(id)}`);
  }

  createPost(data: Record<string, unknown>, key: string = randomUUID()) {
    return this.client
      .request("POST", "/api/v1/posts", data, { "idempotency-key": key })
      .then((result) => ({ result, idempotencyKey: key }))
      .catch((error) => {
        (error as PostoirError & { idempotencyKey?: string }).idempotencyKey = key;
        throw error;
      });
  }

  updatePost(id: string, data: Record<string, unknown>) {
    return this.client.request("PATCH", `/api/v1/posts/${enc(id)}`, data);
  }

  deletePost(id: string) {
    return this.client.request("DELETE", `/api/v1/posts/${enc(id)}`);
  }

  publish(id: string) {
    return this.client.request("POST", `/api/v1/posts/${enc(id)}/publish`);
  }

  async schedule(id: string, at: string) {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(at) ||
      Number.isNaN(Date.parse(at)) ||
      new Date(at).valueOf() <= Date.now()
    )
      throw new PostoirError(
        "INVALID_SCHEDULE",
        "Schedule time must be a future ISO 8601 timestamp with timezone",
      );
    const [date] = at.split("T");
    const [year, month, day] = date.split("-").map(Number);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate())
      throw new PostoirError("INVALID_SCHEDULE", "Schedule date is not valid");
    try {
      return await this.client.request("POST", `/api/v1/posts/${enc(id)}/schedule`, {
        scheduledFor: at,
      });
    } catch (error) {
      if (error instanceof PostoirError && error.code === "PUBLICATION_QUEUE_UNAVAILABLE") {
        const post = await this.post(id);
        throw new PostoirError(
          error.code,
          error.message,
          error.status,
          error.requestId,
          {
            ...(typeof error.details === "object" && error.details
              ? (error.details as Record<string, unknown>)
              : {}),
            post,
          },
          error.retryAfter,
        );
      }
      throw error;
    }
  }

  unschedule(id: string) {
    return this.client.request("DELETE", `/api/v1/posts/${enc(id)}/schedule`);
  }

  async publishWithReconciliation(
    id: string,
  ): Promise<
    { accepted: true; result: unknown } | { accepted: false; post: unknown; error: PostoirError }
  > {
    try {
      return { accepted: true, result: await this.publish(id) };
    } catch (error) {
      if (error instanceof PostoirError && error.code === "PUBLICATION_QUEUE_UNAVAILABLE")
        return { accepted: false, post: await this.post(id), error };
      throw error;
    }
  }

  async watch(
    id: string,
    options: {
      deadline?: Date;
      timeoutMs?: number;
      intervalMs?: number;
      onUpdate?: (value: WatchResult) => void;
    } = {},
  ): Promise<WatchResult> {
    const deadline = options.deadline || new Date(Date.now() + (options.timeoutMs || 10 * 60_000));
    if (Number.isNaN(deadline.valueOf()) || deadline <= new Date())
      throw new PostoirError("INVALID_DEADLINE", "Watch deadline must be in the future");
    let last: WatchResult | undefined;
    while (Date.now() < deadline.valueOf()) {
      try {
        const response = await this.client.requestDetailed<{
          data?: { publications?: Publication[]; socialAccountIds?: string[] };
          publications?: Publication[];
          socialAccountIds?: string[];
        }>(
          "GET",
          `/api/v1/posts/${enc(id)}`,
          undefined,
          {},
          { timeoutMs: Math.max(1, deadline.valueOf() - Date.now()) },
        );
        const raw = response.data;
        const post = raw.data || raw;
        const publications = post.publications || [];
        const expected = post.socialAccountIds || [];
        const terminal = new Set(
          publications
            .filter((p) => ["PUBLISHED", "FAILED", "RECONCILIATION_REQUIRED"].includes(p.status))
            .map((p) => p.socialAccountId),
        );
        const result: WatchResult = {
          postId: id,
          publications,
          complete: expected.length > 0 && expected.every((target) => terminal.has(target)),
          timedOut: false,
        };
        if (JSON.stringify(result) !== JSON.stringify(last)) options.onUpdate?.(result);
        last = result;
        if (result.complete) return result;
        if (response.retryAfter) {
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.min(response.retryAfter! * 1000, deadline.valueOf() - Date.now()),
            ),
          );
          continue;
        }
      } catch (error) {
        if (
          error instanceof PostoirError &&
          error.code === "NETWORK_ERROR" &&
          Date.now() >= deadline.valueOf()
        )
          break;
        if (!(error instanceof PostoirError) || ![429, 503].includes(error.status || 0))
          throw error;
        const delay = Math.max(250, (error.retryAfter || 1) * 1000);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(delay, deadline.valueOf() - Date.now())),
        );
        continue;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(options.intervalMs || 2_000, deadline.valueOf() - Date.now())),
      );
    }
    return { postId: id, publications: last?.publications || [], complete: false, timedOut: true };
  }
  upload(path: string, metadata: Record<string, unknown> = {}) {
    return uploadMedia(this.client, path, metadata);
  }
}

export type Publication = {
  id?: string;
  socialAccountId?: string;
  platform?: string;
  status: string;
  externalPostId?: string;
  externalUrl?: string;
  publishedAt?: string;
};

export type WatchResult = {
  postId: string;
  publications: Publication[];
  complete: boolean;
  timedOut: boolean;
};
