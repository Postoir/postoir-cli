# Errors, permissions, and delivery status

CLI errors are written to stderr. With `--json`, they use a structured `{ error: ... }` object and may include a request ID or creation idempotency key. Preserve those values for support and safe recovery, but never expose the API key.

Exit codes `2`, `3`, `4`, and `5` indicate invalid input, missing authentication, insufficient permission, and rate limiting. `posts watch` returns `6` when a target fails, `7` when the result needs review, and `8` when monitoring times out. Other request or service failures return `1`.

Use the minimum permissions needed for the task. Read operations use the corresponding `*:read` permissions. Upload needs `media:write`; creating, editing, publishing, and scheduling need `posts:write`; deletion needs `posts:delete`.

Correct invalid input, unavailable targets, unsupported formats, or account limits before retrying. Respect any retry delay returned by Postoir. After an uncertain publication response, read the post before attempting another action. Never automatically repeat delivery after a social network has already received an attempt; inspect each target's result first.

List responses are paginated. Use `--page` and `--per-page` to select a page, or `--all` to retrieve every available result.
