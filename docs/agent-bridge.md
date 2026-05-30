# Agent Bridge

Work in the Sun should treat the phone UI as a remote command surface, not as the automation engine. The desktop agent is responsible for interpreting commands, launching applications, switching focus, clicking buttons, editing files, and reporting progress.

## Shape

1. The phone UI captures or types a user instruction.
2. The desktop web server writes a generic command envelope to `.local/agent-commands.jsonl`.
3. A local agent, agent router, or bridge process consumes those commands.
4. The agent responds through the Work in the Sun MCP server, which writes `.local/agent-events.jsonl`.
5. The phone UI polls events and shows or reads the feedback.

This keeps Codex as one possible target rather than the protocol itself. A future bridge can route the same envelopes to Codex, Claude, Cursor, Aider, a browser automation agent, a desktop-control agent, or a custom supervisor.

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
- `use claude scarcity shores planning`

The app does not need to know how to open or attach to that session. It only records the target. The desktop agent bridge resolves the phrase to a real session, creates one when `mode` is `new`, and may send feedback if the target is ambiguous.

## Voice Catalog Commands

Hold the command button and say:

- `list`
- `list projects`
- `list chats`
- `list work in the sun`
- `list chats in work in the sun`
- `continue`
- `use listed one`

`list` asks whether to list projects or chats. `list projects` reads Codex desktop project roots. `list chats` reads recent Codex chats in pages of five, ordered by last use. A project phrase after `list`, such as `list work in the sun`, lists chats for that project. Chat results are read as project first, then chat title, so a global result sounds like `Work in the Sun: Add agent chat support`. `continue` reads the next page of chats when more are available. `use listed one` or `use listed two` sets the active target to a chat from the most recently listed page.

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
  "text": "Open the browser, switch to the running app, and click the save button."
}
```

The command text stays natural language. Desktop app navigation is just another instruction to the selected agent.

## HTTP Surface

- `GET /api/agent/target`
- `POST /api/agent/target`
- `GET /api/agent/commands?after=0&limit=100`
- `POST /api/agent/commands`
- `GET /api/agent/events?after=0&limit=100`
- `POST /api/agent/events`

The old `POST /api/codex/messages` route is kept as a compatibility alias for `POST /api/agent/commands`.

## MCP Server

Run the local MCP server with:

```powershell
npm run mcp
```

Agent configuration should launch:

```powershell
node F:\projects\work-in-the-sun\mcp-server.js
```

Exposed MCP tools:

- `send_feedback`: append progress/result/warning text for the phone UI.
- `list_commands`: read queued commands by cursor.
- `get_active_target`: inspect the selected target.
- `set_active_target`: update the selected target from an agent or router.

For Codex, the MCP server should be configured in the Codex desktop agent environment. For other agents, use their normal MCP server configuration.

## Security Notes

The MCP server is local stdio, so it is not exposed on the network. The web server should still be served only over the intended Tailscale/private surface, and future remote HTTP endpoints should require authentication before they can queue commands or read feedback.

Agent bridges should treat command execution as privileged desktop automation. Dangerous actions should go through the agent's normal confirmation and approval path.
