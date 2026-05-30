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

## Status

Project initialized. Architecture and implementation details are intentionally open while the safest, simplest workflow is designed.
