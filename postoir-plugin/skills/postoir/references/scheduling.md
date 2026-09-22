# Publish, schedule, and monitor

Prefer these MCP tools when available:

- `publish_post({ postId })`: start immediate delivery.
- `schedule_post({ postId, scheduledFor })`: schedule or move delivery.
- `cancel_post_schedule({ postId })`: return a scheduled post to draft before delivery begins.
- `get_post({ postId })`: inspect every destination after a publication request.
- `delete_draft_post({ postId })`: delete the Postoir post and cancel pending work.

CLI equivalents, when the CLI is available:

```sh
postoir posts publish POST_ID
postoir posts schedule POST_ID --at 2030-01-15T09:00:00+01:00
postoir posts schedule POST_ID --at 2030-01-16T09:00:00+01:00 # move
postoir posts unschedule POST_ID
postoir posts get POST_ID
postoir posts watch POST_ID --timeout 120000
postoir posts delete POST_ID
```

The scheduled date must be in the future, use ISO 8601, and include an explicit timezone. Publishing and scheduling start an asynchronous operation; acceptance is not proof of delivery. Read the post after acceptance and report every account's status and published link when available.

Move or cancel a schedule only before delivery begins. Cancelling does not restore usage already consumed by scheduling. MCP has no blocking watch tool, so poll `get_post` only as needed and stop at a terminal state or reasonable timeout. With the CLI, `posts watch` returns exit `6` for a failed target, `7` when the result needs review, and `8` when monitoring times out. Deletion removes the post from Postoir and cancels pending work, but cannot remove content already published on a social network.
