# Writing drafts

Use MCP when its tools are present:

1. Call `list_social_accounts` to resolve target IDs. Use `list_campaigns` only when the post belongs to a campaign, and `list_media` for existing attachments.
2. Call `create_draft_post` with `socialAccountIds`, content, and optional `campaignId` or `mediaIds`. Reuse its `idempotencyKey` only when retrying the same creation.
3. Call `update_draft_post` with `postId` and only the fields that need to change. A `null` campaign ID detaches the campaign.

A writing request creates a draft. Call `publish_post` or `schedule_post` only when the user explicitly requests delivery.

CLI equivalents, when the CLI is available:

```sh
postoir accounts list
postoir campaigns list
postoir media list
postoir posts create --account ACCOUNT_ID --content "A complete launch message." \
  --idempotency-key launch-001
postoir posts create --account ACCOUNT_ID --content-file ./copy.txt \
  --media MEDIA_ID --idempotency-key image-001
postoir posts create --data ./post.json --idempotency-key json-001
printf '%s' '{"content":"Draft","socialAccountIds":["ACCOUNT_ID"]}' \
  | postoir posts create --data - --idempotency-key stdin-001
postoir posts update POST_ID --content "A corrected message."
```

The `--data` document can provide the complete create or update payload. Use a new idempotency key for a different post. With either interface, use IDs returned by Postoir and do not infer a target from a platform name.
