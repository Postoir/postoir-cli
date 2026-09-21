export class PostoirError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly requestId?: string,
    public readonly details?: unknown,
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export function safeMessage(value: unknown): string {
  return String(value instanceof Error ? value.message : value).replace(
    /(bearer\s+|api[_-]?key[=:]\s*)[^\s,]+/gi,
    "$1[redacted]",
  );
}

export function redact(value: unknown, secret: string): unknown {
  if (typeof value === "string") return safeMessage(value).split(secret).join("[redacted]");
  if (Array.isArray(value)) return value.map((x) => redact(x, secret));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        /(key|token|authorization|secret)/i.test(k) ? "[redacted]" : redact(v, secret),
      ]),
    );
  return value;
}
