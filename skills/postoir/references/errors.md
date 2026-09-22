# Errors, permissions, and delivery status

MCP tool failures return structured error data when available, including a stable code, message, request ID, and details. Preserve the request ID and a creation idempotency key for support or safe recovery, but never expose credentials.

CLI errors are written to stderr. With `--json`, they use a structured `{ error: ... }` object. CLI exit codes `2`, `3`, `4`, and `5` indicate invalid input, missing authentication, insufficient permission, and rate limiting. Other request or service failures return `1`.

The CLI-only `posts watch` command returns `6` when a target fails, `7` when the result needs review, and `8` when monitoring times out. With MCP, inspect delivery through `get_post` and each destination's status.

Use the minimum permissions needed for the task. Read operations use the corresponding `*:read` permissions. Upload needs `media:write`; creating, editing, publishing, and scheduling need `posts:write`; deletion needs `posts:delete`.

Correct invalid input, unavailable targets, unsupported formats, or account limits before retrying. Respect any retry delay returned by Postoir. After an uncertain publication response, read the post before attempting another action. Never automatically repeat delivery after a social network has already received an attempt; inspect each target's result first.

MCP list tools accept `page` and `perPage`. CLI list commands use `--page` and `--per-page`, or `--all` to retrieve every available result.
