import { PostoirError, redact, safeMessage } from "./errors.js";

export type ClientOptions = {
  apiUrl: string;
  apiKey: string;
  timeout?: number;
  fetch?: typeof fetch;
};

export class Client {
  readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    const url = new URL(options.apiUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new PostoirError(
        "INVALID_API_URL",
        "API URL must be an http(s) origin without credentials, query, or fragment",
      );
    this.base = url.href.replace(/\/$/, "");
    this.fetcher = options.fetch || fetch;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<T> {
    return (await this.requestDetailed<T>(method, path, body, headers, { timeoutMs })).data;
  }

  async requestDetailed<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    requestOptions: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ data: T; requestId?: string; retryAfter?: number; status: number }> {
    const timeoutMs = requestOptions.timeoutMs;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || this.options.timeout || 30_000);
    const abort = () => ctl.abort();
    requestOptions.signal?.addEventListener("abort", abort, { once: true });
    try {
      const payload =
        body === undefined
          ? undefined
          : body instanceof Uint8Array || body instanceof ReadableStream
            ? body
            : JSON.stringify(body);
      const response = await this.fetcher(this.base + path, {
        method,
        body: payload as BodyInit,
        signal: ctl.signal,
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          accept: "application/json",
          ...(payload && !(body instanceof Uint8Array) && !(body instanceof ReadableStream)
            ? { "content-type": "application/json" }
            : {}),
          ...headers,
        },
        duplex: body instanceof ReadableStream ? "half" : undefined,
      } as RequestInit);
      const requestId = response.headers.get("x-request-id") || undefined;
      const raw = await response.text();
      let parsed: unknown = undefined;
      try {
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch {
        parsed = raw;
      }
      if (!response.ok) {
        const er =
          typeof parsed === "object" && parsed
            ? (
                parsed as {
                  error?: {
                    code?: string;
                    message?: string;
                    requestId?: string;
                    details?: unknown;
                  };
                }
              ).error
            : undefined;
        const msg = redact(
          er?.message || `Request failed (${response.status})`,
          this.options.apiKey,
        ) as string;
        const value = response.headers.get("retry-after");
        const seconds =
          value && /^\d+$/.test(value)
            ? Number(value)
            : value
              ? Math.max(0, (Date.parse(value) - Date.now()) / 1000)
              : undefined;
        throw new PostoirError(
          er?.code || (response.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR"),
          safeMessage(msg),
          response.status,
          er?.requestId || requestId,
          redact(er?.details, this.options.apiKey),
          seconds,
        );
      }
      const retryValue = response.headers.get("retry-after");
      const retryAfter =
        retryValue && /^\d+$/.test(retryValue)
          ? Number(retryValue)
          : retryValue
            ? Math.max(0, (Date.parse(retryValue) - Date.now()) / 1000)
            : undefined;
      return { data: parsed as T, requestId, retryAfter, status: response.status };
    } catch (e) {
      if (e instanceof PostoirError) throw e;
      throw new PostoirError("NETWORK_ERROR", safeMessage(e));
    } finally {
      clearTimeout(timer);
      requestOptions.signal?.removeEventListener("abort", abort);
    }
  }
  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
}

export async function collectPages<T>(first: string, client: Client, all: boolean): Promise<T[]> {
  const url = new URL(first, "https://local.invalid");
  url.searchParams.delete("page");
  url.searchParams.delete("perPage");
  let pageNo = 1;
  const out: T[] = [];
  do {
    url.searchParams.set("page", String(pageNo));
    url.searchParams.set("perPage", "100");
    const page = await client.get<{
      data?: T[];
      pagination?: { page: number; totalPages: number };
    }>(`${url.pathname}${url.search}`);
    out.push(...(page.data || []));
    if (!all || !page.pagination || pageNo >= page.pagination.totalPages) break;
    pageNo++;
  } while (true);
  return out;
}
