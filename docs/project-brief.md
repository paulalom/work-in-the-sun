# Project Brief

## Purpose

Work in the Sun exists to let a developer initiate, supervise, and steer AI-assisted development on a desktop workstation from a phone or another remote device without moving the development environment into the cloud.

## Working Assumptions

- The desktop is the trusted development host.
- Remote devices should not need full repository clones or long-lived secrets.
- Access should use Tailscale for the MVP.
- AI tools should operate close to the codebase on the desktop.
- The user experience should be useful from a small screen, not merely technically possible.

## Questions to Resolve

- What is the smallest useful remote control surface?
- How should authentication and device trust be handled?
- What parts of the development loop need a phone-native interface?
- Which AI tooling should be supported first?

## Candidate Milestones

1. Document the target workflow and threat model.
2. Set up Tailscale on the phone and desktop.
3. Prototype a desktop endpoint with a narrow command surface.
4. Build a mobile-friendly control UI.
5. Add observability, session history, and kill-switch controls.
