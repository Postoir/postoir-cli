# Local media

Media upload requires `media:write`. Upload a supported local image or video of at most 100 MiB. Image dimensions are detected automatically. Video dimensions and duration are detected with `ffprobe` when available; otherwise they must be supplied explicitly.

```sh
postoir media upload ./photo.jpg --content-type image/jpeg
postoir media upload ./clip.mp4 --content-type video/mp4 \
  --title "Launch clip" --width 1920 --height 1080 --duration 12.5
postoir posts create --account ACCOUNT_ID --content "New work." \
  --media MEDIA_ID --idempotency-key media-001
```

Supported formats are JPEG, PNG, GIF, WebP, MP4, WebM, and QuickTime. Use the media ID returned by Postoir when creating or updating a draft. If an upload fails, report the error and its request ID; do not invent or reuse an unconfirmed media ID.
