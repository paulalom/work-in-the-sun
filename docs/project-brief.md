# Project Brief

## Purpose

Work in the Sun exists to let a developer initiate, supervise, and steer AI-assisted development on a desktop workstation from a phone or another remote device without moving the development environment into the cloud.

The product posture is speech-first: the primary method of work is a speech-to-text instruction loop with concise text-to-speech feedback. Typed text, visual status, screenshots, and transcripts are fallback and review paths rather than the default interaction model.

## Working Assumptions

- The desktop is the trusted development host.
- Remote devices should not need full repository clones or long-lived secrets.
- Access should use Tailscale for the MVP.
- AI tools should operate close to the codebase on the desktop.
- The primary interaction should be audio-first, with text and visuals available when speech is inconvenient, ambiguous, or needs review.
- The user experience should be useful from a small screen, not merely technically possible.
- The app should route natural-language commands to a selected desktop agent rather than become a Codex-specific command runner.

## Questions to Resolve

- What is the smallest useful remote control surface?
- How should authentication and device trust be handled?
- What parts of the development loop need a phone-native interface?
- Which AI tooling should be supported first?
- How should target phrases like "codex work in the sun agent chat" resolve to durable agent sessions?

## Candidate Milestones

1. Document the target workflow and threat model.
2. Set up Tailscale on the phone and desktop.
3. Prototype a desktop endpoint with a narrow command surface.
4. Build a mobile-friendly control UI.
5. Add observability, session history, and kill-switch controls.
