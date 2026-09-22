# Connection

## Marketplace plugin and hosted MCP

Prefer the Postoir MCP tools already connected by the client. A marketplace plugin does not guarantee that the `postoir` executable is installed. The hosted service is available at `https://postoir.com/mcp`, and compatible clients handle the Postoir OAuth sign-in flow.

If Postoir tools are missing, ask the user to enable or reconnect the plugin. Do not fall back to shell commands unless the `postoir` CLI is actually available.

## Local CLI and local MCP

Use the CLI for local profiles and operations that require filesystem access. Sign in with `postoir auth login --api-key KEY`, or pipe the key through stdin. Use `postoir auth status`, `postoir auth logout`, `postoir profiles list`, and `postoir profiles use NAME` to manage local profiles.

`POSTOIR_API_KEY` takes precedence over the selected profile. `POSTOIR_API_URL` or `--api-url` can select another compatible Postoir instance. Never place an API key in a URL, prompt, tool argument, log, or committed file.

For a local MCP connection, `postoir mcp config claude|cursor` generates configuration without embedding credentials, and `postoir mcp serve` reads the credential from the environment or selected profile. The local adapter can expose `upload_media` because it can read local files; the hosted MCP service cannot read arbitrary client paths.

API and MCP availability depends on the workspace plan and the permissions granted to the credential. If an older key does not allow media upload, create a new key with `media:write`.
