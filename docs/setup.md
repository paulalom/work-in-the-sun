# Setup

This project has two local surfaces:

- the Work in the Sun web backend, which serves the phone/tablet UI and HTTP API;
- the Work in the Sun MCP server, which lets desktop agents report progress and read the command bridge state.

The MCP server is not discovered just because `mcp-server.js` exists in the project. The desktop agent host must be configured to launch or connect to it.

## Terminology

The most precise phrasing is:

- Configure the MCP server in the agent host or MCP client.
- The client starts or connects to the MCP server.
- The client calls `initialize` and `tools/list`.
- The host exposes the discovered tools to the agent.

"Attach the MCP server to the agent" is understandable shorthand. "Subscribe" is less accurate here unless we add an MCP notification or resource subscription flow later. The model itself does not subscribe to the server directly; Codex Desktop acts as the MCP client and gives the agent access to the tools it discovers.

## Local Startup

Install the Local Dictate release dependency:

```powershell
.\scripts\install-local-dictate.ps1
```

Start the backend locally:

```powershell
npm run dev
```

The backend serves the frontend UI and API from one HTTP server. The default bind is `127.0.0.1:38173`; keep the `3817x` range reserved for Work in the Sun local web surfaces. Set `WITS_HTTP_PORT` or `PORT` to override it.

The backend needs `ffmpeg` on `PATH`, or `FFMPEG_PATH` set. For phone testing, serve the backend through Tailscale HTTPS so browser audio capture works securely.

## Remote Access

Use either a strong access token or a first-connection PIN.

For a token:

```powershell
$bytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
$env:WITS_ACCESS_TOKEN = [Convert]::ToHexString($bytes).ToLower()
npm run dev
```

Open the app from the phone with the token in the URL fragment:

```text
https://your-tailscale-host/#wits_token=...
```

For a PIN:

```powershell
New-Item -ItemType Directory -Force .local | Out-Null
$pin = Read-Host "New Work in the Sun PIN"
Set-Content -NoNewline .local\access-pin $pin
npm run dev
```

The PIN unlock key is stored in `.local/pin-unlock-key.json`. The browser remembers its fingerprint after a successful unlock and refuses future PIN entry if it changes. After three failed PIN attempts, the backend writes `.local/pin-lockout.json` and exits. Clear it only after checking `.local/pin-failures.log`:

```powershell
npm run pin:unlock
```

## Backend Service

Install the current-user startup service:

```powershell
npm run service:install
npm run service:start
```

The service is named `WorkInTheSunBackend`. It runs `scripts/backend-service-runner.ps1`, logs to `.local/backend-service.log`, reads optional machine-specific environment from `.local/service.env`, and refuses to start while `.local/pin-lockout.json` exists.

Example `.local/service.env`:

```powershell
HOST=0.0.0.0
WITS_HTTP_PORT=38173
WITS_ALLOWED_WORKSPACE_ROOTS=F:\projects
```

## MCP Server

The MCP server is a stdio process:

```powershell
npm run mcp
```

That command is useful for manual testing. For normal agent use, configure the agent host to launch:

```powershell
node F:\projects\work-in-the-sun\mcp-server.js
```

The server exposes:

- `send_feedback`: append summarized progress, result, warning, or error text for the remote UI.
- `use_mcp_concise_replies`: tell the agent to send compact UI feedback through `send_feedback`.
- `list_commands`: read queued user commands from `.local/agent-commands.jsonl`.
- `get_active_target`: inspect the selected desktop agent target.
- `set_active_target`: update the selected desktop agent target.

### Codex Desktop

Codex Desktop reads MCP server configuration from `%USERPROFILE%\.codex\config.toml`. Add a server entry like:

```toml
[mcp_servers.work_in_the_sun]
args = ['F:\projects\work-in-the-sun\mcp-server.js']
command = 'C:\Program Files\nodejs\node.exe'
startup_timeout_sec = 30

[mcp_servers.work_in_the_sun.env]
AGENT_WORKSPACE = 'F:\projects\work-in-the-sun'
```

After changing MCP configuration, start a new Codex session or reload the Codex app. Already-running sessions may keep the tool list they had at startup.

Expected Codex-side tool names are usually namespaced by server, such as `mcp__work_in_the_sun__use_mcp_concise_replies` and `mcp__work_in_the_sun__send_feedback`.

### Smoke Test

To check that the server itself works independently of Codex, send a tiny JSON-RPC conversation:

```powershell
$messages = @(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"manual-check","version":"0"}}}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
) -join "`n"

$messages | node F:\projects\work-in-the-sun\mcp-server.js
```

If that lists the tools but Codex cannot use them, the MCP server is working and the problem is Codex host configuration, startup, or session reload.
