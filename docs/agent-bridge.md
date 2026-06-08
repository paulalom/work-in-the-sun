# Agent Bridge

Work in the Sun should treat the phone UI as a remote command surface, not as the automation engine. The desktop agent is responsible for interpreting commands, launching applications, switching focus, clicking buttons, editing files, and reporting progress.

## Shape

1. The phone UI captures or types a user instruction.
2. The desktop web server writes a generic command envelope to `.local/agent-commands.jsonl`.
3. A local agent, agent router, or bridge process consumes those commands.
4. The agent responds through the Work in the Sun MCP server, which writes `.local/agent-events.jsonl`.
5. The phone UI polls events and shows or reads the feedback.

This keeps Codex as one possible target rather than the protocol itself. A future bridge can route the same envelopes to Codex, Claude, Cursor, Aider, a browser automation agent, a desktop-control agent, or a custom supervisor.

## Codex Desktop Push

The generic queue remains the core contract, but the backend also has Codex delivery drivers. On Windows, when `CODEX_DIRECT_SEND` is not `0`, Codex targets are sent through the visible Codex desktop window by default. New Codex targets with a resolved project select that project in the sidebar before pressing New Chat, so the new thread starts in the intended project instead of inheriting whichever project was active.

1. Find the Codex window with Windows UI Automation.
2. If the selected target names a chat, click the matching visible sidebar chat.
3. Focus and briefly highlight the ProseMirror composer.
4. Paste the command through the clipboard, restore the prior clipboard, and press Enter.
5. Poll the visible UI Automation document text and relay visible output changes into `.local/agent-events.jsonl`.

This keeps the desktop app as the authority for the visible chat, streaming UI, and permission controls. It is intentionally more like a careful desktop agent than a hidden API call.

Set `CODEX_DELIVERY_MODE=app-server-stdio` to use the previous experimental app-server path instead:

1. Start `codex app-server --listen stdio://`.
2. Initialize the app-server client.
3. `thread/resume` the selected thread, or `thread/start` when the target mode is `new`.
4. `turn/start` with the natural language command as text input.
5. Stream completed Codex agent messages back into `.local/agent-events.jsonl`.

This is still intentionally backend-to-agent, not browser-to-Codex. The phone never receives Codex credentials or talks to Codex directly.

Interactive approval prompts are not handled by the hidden app-server fallback. If Codex asks for command or file-change approval during an app-server pushed turn, the bridge records a warning event and cancels that approval instead of approving privileged work automatically.

## Active Target

The app stores the selected target in `.local/agent-state.json`.

Target fields are intentionally generic:

```json
{
  "id": "codex:work-in-the-sun:agent-chat",
  "provider": "codex",
  "label": "Codex / work in the sun agent chat",
  "workspace": "F:\\projects\\work-in-the-sun",
  "sessionHint": "work in the sun agent chat",
  "mode": "existing",
  "route": "work in the sun agent chat"
}
```

`id` is stable when the consuming bridge knows a real session id. `sessionHint` and `route` are intentionally fuzzy when the user only knows a name or phrase. `mode` is `existing` or `new`.

## Voice Target Commands

Hold the command button and say:

- `use codex work in the sun agent chat`
- `use codex work in the sun new`
- `use new work in the sun`
- `use work in the sun new`
- `use claude scarcity shores planning`

The app does not need to know how to open or attach to that session. It only records the target. Short new-chat phrases default to Codex and resolve the project name through the Codex project catalog. The desktop agent bridge resolves the phrase to a real session, creates one when `mode` is `new`, and may send feedback if the target is ambiguous.

## Voice Catalog Commands

Hold the command button and say:

- `list`
- `list projects`
- `list chats`
- `list work in the sun`
- `list chats in work in the sun`
- `continue`
- `use one`
- `use listed one`
- `screenshot`

`list` asks whether to list projects or chats. `list projects` reads Codex desktop project roots. `list chats` reads recent Codex chats in pages of five, ordered by last use. A project phrase after `list`, such as `list work in the sun`, lists chats for that project. Chat results are read as project first, then chat title, so a global result sounds like `Work in the Sun: Add agent chat support`. `continue` reads the next page of chats when more are available. `use one`, `use listed one`, or `use listed two` sets the active target to a chat from the most recently listed page.

`screenshot` captures only the active desktop window and shows the image in the remote UI. When the active target is a Codex chat, the bridge brings Codex forward and selects the target chat before capturing the Codex window.

## Command Envelope

Commands are queued as JSON Lines:

```json
{
  "id": "4f25b5dd-5c95-4cae-a2fc-7bda2b7fd8fb",
  "receivedAt": "2026-05-30T22:30:00.000Z",
  "status": "queued",
  "kind": "agent.command",
  "input": "voice",
  "source": "manual",
  "echo": false,
  "target": {
    "id": "codex:work-in-the-sun:agent-chat",
    "provider": "codex",
    "label": "Codex / work in the sun agent chat",
    "workspace": "F:\\projects\\work-in-the-sun",
    "sessionHint": "work in the sun agent chat",
    "mode": "existing",
    "route": "work in the sun agent chat"
  },
  "userText": "Open the browser, switch to the running app, and click the save button.",
  "text": "[From Work in the Sun UI]\nUse the MCP tool use_mcp_concise_replies.\n\nUser request:\nOpen the browser, switch to the running app, and click the save button."
}
```

Desktop app navigation is just another instruction to the selected agent.
For Codex delivery, `text` is agent-facing and is prefixed with a short Work in the Sun UI note telling the agent to call `use_mcp_concise_replies`. The tool then instructs the agent to send summarized UI messages with `send_feedback`. `userText` preserves the original draft without the prefix.

## HTTP Surface

The frontend UI and backend API share one HTTP server. The React/TypeScript source lives in `ui/` and builds to `dist/app`; the backend TypeScript source builds to `dist/server`. Its default local port is `38173`; use the `3817x` range for Work in the Sun web surfaces when a separate UI or helper server is added.

- `GET /api/agent/target`
- `POST /api/agent/target`
- `GET /api/agent/commands?after=0&limit=100`
- `POST /api/agent/commands`
- `GET /api/agent/events?after=0&limit=100`
- `POST /api/agent/events`
- `POST /api/screenshot/active-window`

The old `POST /api/codex/messages` route is kept as a compatibility alias for `POST /api/agent/commands`.

All `/api/*` routes are guarded by the desktop HTTP boundary:

- Set `WITS_ACCESS_TOKEN` before serving over Tailscale, a LAN, or any reverse proxy. Remote requests without a token are rejected.
- Browser requests send the token as `X-WITS-Token`; non-browser clients may use `Authorization: Bearer ...`. If entering a token manually in the browser, prefer `#wits_token=...` over a query string because URL fragments are not sent in HTTP requests.
- Alternatively, save a first-connection PIN in `.local/access-pin` or set `WITS_ACCESS_PIN`. PIN unlock uses application-layer encryption: the browser encrypts the PIN to the backend's `.local/pin-unlock-key.json` public key, and a successful unlock returns the browser-session token encrypted to that single attempt.
- Failed PIN attempts are appended to `.local/pin-failures.log` without recording the submitted PIN. After three failed attempts, the backend writes `.local/pin-lockout.json` and shuts down.
- The backend prints the PIN unlock public-key fingerprint at startup. The browser remembers the fingerprint after a successful unlock and refuses future PIN entry if it changes.
- The PIN screen shows a server identity detail with the app version, the host the browser connected to, and the unlock-key fingerprint. It does not expose the OS machine hostname before authentication.
- Cross-origin requests are rejected unless their origin is explicitly listed in `WITS_ALLOWED_ORIGINS`.
- JSON endpoints require `application/json`, enforce request size limits, and have per-client rate limits.
- Agent providers default to `codex,agent`; set `WITS_ALLOWED_AGENT_PROVIDERS` to opt in more.
- Agent workspaces default to this project root; set `WITS_ALLOWED_WORKSPACE_ROOTS` to opt in parent folders such as `F:\projects`.

MITM boundary: encrypted PIN unlock prevents passive capture of the PIN and session token at the app protocol layer, and fingerprint pinning catches backend key changes after first trust. It does not replace HTTPS/Tailscale HTTPS for the first page load; if an attacker can rewrite the JavaScript before the browser trusts the backend key, they can change the unlock code. Remote use should therefore stay on Tailscale HTTPS or another trusted TLS surface.

## Backend Startup Service

Use the bundled Windows Scheduled Task wrapper to start the backend when the desktop user signs in:

```powershell
npm run service:install
npm run service:start
```

The task is named `WorkInTheSunBackend`. If Windows denies task registration, the installer falls back to a current-user Startup entry named `WorkInTheSunBackend.cmd`. Both paths run `scripts/backend-service-runner.ps1`, append output to `.local/backend-service.log`, import optional environment values from `.local/service.env`, and refuse to start if `.local/pin-lockout.json` exists. Clear the lockout only after reviewing `.local/pin-failures.log`:

```powershell
npm run pin:unlock
```

## MCP Server

Run the local MCP server with:

```powershell
npm run mcp
```

For agent configuration, run `npm run backend:build` after source updates, then launch:

```powershell
node F:\projects\work-in-the-sun\dist\server\mcp-server.js
```

Exposed MCP tools:

- `send_feedback`: append summarized progress/result/warning text for the phone UI.
- `use_mcp_concise_replies`: ask the agent to send summarized messages to the Work in the Sun UI with `send_feedback`, and persist that preference in `.local/agent-state.json`.
- `list_commands`: read queued commands by cursor.
- `get_active_target`: inspect the selected target.
- `set_active_target`: update the selected target from an agent or router.

For Codex, the MCP server should be configured in the Codex desktop agent environment. For other agents, use their normal MCP server configuration.

## Security Notes

The MCP server is local stdio, so it is not exposed on the network. The web server should still be served only over the intended Tailscale/private surface, with `WITS_ACCESS_TOKEN` or a configured PIN required for remote access. Rotate the token/PIN and restart the server to revoke a device.

Agent bridges should treat command execution as privileged desktop automation. Dangerous actions should go through the agent's normal confirmation and approval path.
