# Postoir CLI

Postoir brings social publishing workflows to the command line and to MCP-compatible assistants. Create drafts, attach media, schedule publications, publish on demand, and follow delivery from one consistent interface.

The CLI is open source. It connects to Postoir, a commercial service; access to API and MCP features depends on your Postoir plan.

## Install

Node.js 22 or later is required.

```sh
npm install -g postoir
postoir --help
```

You can also run the CLI without a global installation:

```sh
npx --yes postoir organization get
```

For a local package archive:

```sh
npm install -g /path/to/postoir-0.1.0.tgz
```

## Sign in

Create an API key from your Postoir workspace, then save it to a named local profile. The available actions depend on the permissions granted to the key.

```sh
printf '%s' "$POSTOIR_API_KEY" | postoir auth login --profile production
postoir auth status --profile production
postoir profiles list
postoir profiles use production
postoir auth logout --profile production
```

Postoir stores profiles in your user configuration directory and never prints saved credentials. `POSTOIR_API_KEY` takes precedence over the selected profile. Use `POSTOIR_API_URL` or `--api-url` only when connecting to another compatible Postoir instance.

Keep API keys out of source control, URLs, prompts, and shared configuration files.

## Explore your workspace

Use list commands to find the account, campaign, media, and post IDs required by other commands.

```sh
postoir organization get
postoir accounts list
postoir campaigns list
postoir media list
postoir posts list --status DRAFT
postoir accounts list --all
```

List commands support pagination. Use `--page` and `--per-page` to select a page, or `--all` to retrieve every available result.

## Create and edit drafts

`posts create` always creates a draft. Publishing and scheduling remain explicit actions.

```sh
postoir posts create \
  --account ACCOUNT_ID \
  --content "Our next chapter starts today." \
  --idempotency-key launch-001

postoir posts create \
  --account ACCOUNT_ID \
  --content-file ./copy.txt \
  --idempotency-key copy-001

postoir posts create --data ./post.json --idempotency-key json-001

printf '%s' '{"content":"A draft","socialAccountIds":["ACCOUNT_ID"]}' \
  | postoir posts create --data - --idempotency-key stdin-001

postoir posts update POST_ID --content "Corrected copy"
postoir posts get POST_ID
postoir posts delete POST_ID
```

An idempotency key protects a creation from accidental duplication. Reuse the same key only when retrying the same request. If a creation cannot be confirmed, Postoir includes the key in the error so the operation can be resumed safely.

Deleting a post removes it from Postoir and cancels work that has not started. It does not remove content already published on a social network.

## Upload media

Upload a supported image or video, then use the returned media ID in a draft. Files may be up to 100 MiB. Supported formats are JPEG, PNG, GIF, WebP, MP4, WebM, and QuickTime.

```sh
postoir media upload ./photo.jpg --content-type image/jpeg

postoir media upload ./clip.mp4 \
  --content-type video/mp4 \
  --title "Launch clip" \
  --width 1920 \
  --height 1080 \
  --duration 12.5

postoir posts create \
  --account ACCOUNT_ID \
  --content "Watch this." \
  --media MEDIA_ID \
  --idempotency-key video-001
```

Image dimensions are detected automatically. For video, Postoir uses `ffprobe` when available; otherwise provide `--width`, `--height`, and `--duration`. Upload requires the `media:write` permission.

## Publish, schedule, and monitor

```sh
postoir posts publish POST_ID
postoir posts schedule POST_ID --at 2030-01-15T09:00:00+01:00
postoir posts schedule POST_ID --at 2030-01-16T09:00:00+01:00
postoir posts unschedule POST_ID
postoir posts watch POST_ID --timeout 120000
```

Scheduled dates must be in the future and include an explicit timezone. A schedule can be changed or cancelled until delivery begins.

Publication is asynchronous. An accepted request means Postoir has started processing it, not that every destination has published successfully. Use `posts watch` or `posts get` to inspect each account's status and published link when available. If the result is uncertain, check the post before starting another publication action.

## Automation and JSON output

Global options can be used with any command:

```text
--json
--all
--profile NAME
--api-url URL
--timeout MS
```

`--json` writes machine-readable results to stdout. Errors are written to stderr and may include a request ID and an idempotency key for support or safe recovery. The CLI never includes configured credentials in its output.

Exit codes:

| Code | Meaning                         |
| ---: | ------------------------------- |
|    0 | Success                         |
|    1 | Request or service error        |
|    2 | Invalid command or input        |
|    3 | Authentication required         |
|    4 | Permission denied               |
|    5 | Rate limited                    |
|    6 | At least one publication failed |
|    7 | Publication state needs review  |
|    8 | Monitoring timed out            |

## MCP

Postoir is available as a hosted MCP service at `https://postoir.com/mcp`. Compatible clients can connect and complete the Postoir sign-in flow.

For Claude Code or Cursor, generate a local configuration after making the credential available to the host environment:

```sh
export POSTOIR_API_KEY
postoir mcp config claude
postoir mcp config cursor
postoir mcp serve
```

`mcp config` does not embed your API key. The generated configuration runs `postoir mcp serve`, which communicates over standard input and output.

## Agent skill

The package includes a focused Postoir skill for Claude Code, Cursor, and custom skill directories:

```sh
postoir skills list
postoir skills install claude
postoir skills install cursor
postoir skills install --dir ./my-agent-skills
```

The installer never replaces an existing Postoir skill. The installed skill guides assistants through account selection, drafting, media, scheduling, publishing, and delivery follow-up.

## Help

Run `postoir --help` to list commands. Run `postoir doctor` to verify the current profile, connectivity, and local media capabilities.

When contacting Postoir support, include the command used, the returned request ID, and the idempotency key when one is present. Never include your API key.

## License

Postoir CLI is licensed under the [Apache License 2.0](LICENSE). The license applies to this CLI and its bundled skill, not to the Postoir service, API implementation, branding, or other proprietary Postoir software.
