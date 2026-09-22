---
name: postoir
description: Manage Postoir drafts, media, publishing, scheduling, and delivery follow-up through Postoir MCP tools, with the CLI as a local fallback.
---

# Postoir

Choose the available interface before acting:

1. Prefer Postoir MCP tools when they are available. This is the normal path for a plugin installed from a marketplace and does not require the `postoir` executable.
2. Use the Postoir CLI only when MCP tools are unavailable or the task needs local machine access, such as uploading a file from disk.
3. If neither interface is available, explain that the Postoir connection or CLI must be installed. Do not issue shell commands that cannot run in the current environment.

Resolve account, campaign, media, and post IDs with Postoir before acting. A writing request creates a draft. An explicit publish or schedule request authorizes that action without another confirmation. Ask only for missing information that changes the target or result.

An accepted publication request is not proof of delivery. Check the post and report the status and published link for every target. If a publication result is uncertain, read the post before attempting another action. Attach media only with IDs returned by Postoir.

Core MCP tools are `list_social_accounts`, `list_campaigns`, `list_media`, `list_posts`, `get_post`, `create_draft_post`, `update_draft_post`, `delete_draft_post`, `publish_post`, `schedule_post`, and `cancel_post_schedule`. The local CLI MCP adapter can additionally expose `upload_media` for files on disk.

Read only the reference needed for the task:

- [connection](references/connection.md): choosing MCP or CLI, profiles, and credentials.
- [writing](references/writing.md): MCP-first drafts and account targeting, with CLI equivalents.
- [media](references/media.md): existing MCP media and local file upload.
- [scheduling](references/scheduling.md): publish, schedule, move, cancel, deletion, and monitoring.
- [errors](references/errors.md): MCP and CLI errors, permissions, limits, statuses, and recovery.
