# Goals and Decisions

## Goal

Enable a developer to take a phone somewhere like a park and continue working on apps in Codex while the real development environment stays on their desktop.

## MVP

- Use a mobile-friendly website as the first phone interface.
- Serve the MVP through Tailscale, from the desktop to the phone.
- Keep code, credentials, editor state, and Codex execution on the desktop.
- Use dictation as a first-class input path, matching the existing desktop workflow.
- Use Tailscale on both devices for secure phone-to-desktop access.
- Avoid exposing any public inbound service directly from the desktop.
- Start with a single-user setup, then generalize once the workflow is proven.

## Decisions

- Desktop remains the trusted development host.
- Phone is a remote control surface, not a development environment.
- Web is preferred for the MVP; a standalone mobile app is deferred until there is a clear need.
- Tailscale is the MVP tunnel layer.
- Build the phone UI first, with push-to-talk and echo mode as the primary loop.
- Send short audio captures to a desktop Local Dictate backend first; defer phone-local transcription.
- The remote interface should expose a narrow set of actions: send instructions, choose the target agent/session, view progress, review output, approve risky steps, and stop work.
- Treat Codex as one supported agent target, not as the app protocol. Commands should be generic natural-language instructions routed to the selected desktop agent.
- Desktop application control, such as opening apps, switching focus, and clicking buttons, should be expressed as instructions to the agent rather than implemented directly in the phone UI.
- Agents should report progress back through a local MCP server so the app can stay generic across Codex and other agent software.
- Security must include strong authentication, easy revocation, and a clear way to shut down remote access.

## Open Questions

- What desktop agent bridge should consume `.local/agent-commands.jsonl` first?
- How should fuzzy target phrases map to durable chat/session ids for each agent?
- How should device trust, login, and session expiry work?
- What phone-specific controls are needed beyond dictation and chat?
- When, if ever, is a standalone phone app worth the added complexity?

## Success Criteria

- The user can continue real Codex-driven app development from a phone.
- The desktop does not expose broad public network access.
- The setup feels reliable enough to use outside the house.
- The MVP teaches what should be generalized for other devices and users.
