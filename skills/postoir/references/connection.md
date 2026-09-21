# Connection

Use the `postoir` command. Sign in with `auth login --api-key KEY`, or pipe the key through stdin. Use `auth status`, `auth logout`, `profiles list`, and `profiles use NAME` to manage local profiles.

`POSTOIR_API_KEY` takes precedence over the selected profile. `POSTOIR_API_URL` or `--api-url` can select another compatible Postoir instance. Never place an API key in a URL, prompt, tool argument, log, or committed file.

The hosted MCP service is available at `https://postoir.com/mcp`. Compatible clients can use the Postoir sign-in flow. For a local MCP connection, `mcp config claude|cursor` generates configuration without embedding credentials, and `mcp serve` reads the credential from the environment or selected profile.

API and MCP availability depends on the workspace plan and the permissions granted to the credential. If an older key does not allow media upload, create a new key with `media:write`.
