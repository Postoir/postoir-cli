# Media

For media already stored in Postoir, prefer MCP: call `list_media`, then pass returned IDs as `mediaIds` to `create_draft_post` or `update_draft_post`.

The hosted MCP service cannot read a file path on the user's machine. For a new local image or video, use `upload_media` only when that tool is exposed by the local CLI MCP adapter. Otherwise use the installed CLI directly. Do not tell a marketplace-plugin user to run the CLI unless it is available in their environment.

Local upload requires `media:write` and supports files up to 100 MiB. Image dimensions are detected automatically. Video dimensions and duration are detected with `ffprobe` when available; otherwise supply them explicitly.

```sh
postoir media upload ./photo.jpg --content-type image/jpeg
postoir media upload ./clip.mp4 --content-type video/mp4 \
  --title "Launch clip" --width 1920 --height 1080 --duration 12.5
postoir posts create --account ACCOUNT_ID --content "New work." \
  --media MEDIA_ID --idempotency-key media-001
```

Supported formats are JPEG, PNG, GIF, WebP, MP4, WebM, and QuickTime. Low-level MCP runtimes may expose `reserve_media_upload`, `finalize_media_upload`, and `cancel_media_upload`; use that sequence only when the runtime can transfer the exact local bytes to the returned signed URL and measure the required metadata. If an upload fails, report the error and request ID; do not invent or reuse an unconfirmed media ID.
