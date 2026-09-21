# Writing drafts

Resolve `ACCOUNT_ID` with `postoir accounts list` and an optional campaign with `postoir campaigns list`. A writing request creates a draft. Publish or schedule only when explicitly requested.

```sh
postoir posts create --account ACCOUNT_ID --content "A complete launch message." \
  --idempotency-key launch-001
postoir posts create --account ACCOUNT_ID --content-file ./copy.txt \
  --media MEDIA_ID --idempotency-key image-001
postoir posts create --data ./post.json --idempotency-key json-001
printf '%s' '{"content":"Draft","socialAccountIds":["ACCOUNT_ID"]}' \
  | postoir posts create --data - --idempotency-key stdin-001
postoir posts update POST_ID --content "A corrected message."
```

Use an idempotency key for creation and reuse it only for the same request. The `--data` document can provide the complete create or update payload. Use a new key for a different post. Always use account IDs returned by Postoir; do not infer a target from a platform name.
