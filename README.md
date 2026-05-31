# Work in the Sun

Work in the Sun is a project for making secure, remote AI-assisted development practical from a phone, tablet, or another device back to a desktop workstation.

The core idea is simple: keep the serious compute, credentials, editor state, and local files on the desktop, then expose only the minimum secure interface needed to drive development remotely through a tunnel.

## Goals

- Enable remote development workflows from mobile and secondary devices.
- Keep source code and secrets anchored on the desktop machine.
- Support AI tooling that can operate against the desktop workspace.
- Use Tailscale rather than broad inbound network exposure.
- Make setup repeatable enough to trust and pleasant enough to actually use.

## Early Scope

- Define the remote access architecture.
- Use Tailscale on the phone and desktop for the MVP tunnel.
- Prototype a phone-to-desktop development loop.
- Document security assumptions, risks, and mitigations.
- Build toward a small, reliable local control surface.

## Docs

- [Goals and Decisions](docs/goals-and-decisions.md)
- [Agent Bridge](docs/agent-bridge.md)

## UI Prototype

Install the Local Dictate release dependency:

```powershell
.\scripts\install-local-dictate.ps1
```

Run the desktop-hosted web app:

```powershell
npm run dev
```

The backend also needs `ffmpeg` on `PATH`, or `FFMPEG_PATH` set. For phone testing, serve it over Tailscale HTTPS so browser audio capture is allowed.

Remote access must use a strong access token or a first-connection PIN. To use a token directly, generate one, start the server with it, then open the app once with the token in the URL:

```powershell
$bytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
$env:WITS_ACCESS_TOKEN = [Convert]::ToHexString($bytes).ToLower()
npm run dev
```

Open `https://your-tailscale-host/#wits_token=...` from the phone. The hash fragment is not sent in the HTTP request, and the app removes it after storing the token for the browser session. API clients can also use `Authorization: Bearer ...`.

For a friendlier first connection, save a PIN in `.local/access-pin` instead. The browser encrypts the PIN to the backend's local unlock key, the server returns the browser session token encrypted back to that unlock attempt, logs failed PIN attempts to `.local/pin-failures.log`, and shuts itself down after three bad PINs:

```powershell
New-Item -ItemType Directory -Force .local | Out-Null
$pin = Read-Host "New Work in the Sun PIN"
Set-Content -NoNewline .local\access-pin $pin
npm run dev
```

You can also set `WITS_ACCESS_PIN` or point `WITS_PIN_PATH` at another local file. Keep the PIN at least six characters unless you intentionally set `WITS_ALLOW_WEAK_PIN=1` for local testing.

The unlock key is saved at `.local/pin-unlock-key.json`, and the backend prints its public fingerprint at startup. The browser remembers that fingerprint after a successful unlock and refuses future PIN entry if it changes. For remote use, still load the app over Tailscale HTTPS; application-layer PIN encryption protects the PIN payload, but HTTPS is what prevents a first-load attacker from rewriting the web app itself.

If three PIN attempts fail, the backend writes `.local/pin-lockout.json` and exits. The startup service will not restart while that marker exists. Clear it only after you have checked the failure log:

```powershell
npm run pin:unlock
```

Install the backend startup service for the current Windows user:

```powershell
npm run service:install
npm run service:start
```

This tries to create a Scheduled Task named `WorkInTheSunBackend`. If Windows denies task registration, it falls back to a current-user Startup entry at `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\WorkInTheSunBackend.cmd`. Both paths run `scripts/backend-service-runner.ps1`, log to `.local/backend-service.log`, read optional machine-specific environment values from `.local/service.env`, and refuse to start if `.local/pin-lockout.json` exists.

Example `.local/service.env`:

```powershell
HOST=0.0.0.0
PORT=4173
WITS_ALLOWED_WORKSPACE_ROOTS=F:\projects
```

By default, agent targets are limited to the current project and providers `codex,agent`. To allow more project roots or providers, set:

```powershell
$env:WITS_ALLOWED_WORKSPACE_ROOTS = "F:\projects"
$env:WITS_ALLOWED_AGENT_PROVIDERS = "codex,agent,claude,cursor"
```

Sent transcripts are queued locally in `.local/agent-commands.jsonl` for a desktop agent or router to consume. The `screenshot` command captures the active desktop window and shows it in the remote UI; for Codex targets, the bridge selects the target chat first. Agents can send progress back through the local MCP server:

```powershell
npm run mcp
```

## Status

Project initialized. The current prototype has speech input, active-window screenshots, a generic agent command inbox, configurable active agent target, and an MCP feedback path.
