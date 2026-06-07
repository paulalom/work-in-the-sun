# TypeScript Migration

Goal: move the remaining backend JavaScript to TypeScript without changing runtime behavior.

1. Add a backend `tsconfig` that compiles CommonJS to `dist/server` and includes `server`, `mcp-server`, `lib`, and backend tests.
2. Add backend build/check scripts, then keep existing `npm run check` green.
3. Create shared backend types for agent targets, commands, events, catalog records, MCP messages, bridge routes, and screenshot results.
4. Migrate the leaf module `lib/window-screenshot.js`; update imports and backend syntax checks.
5. Migrate `lib/agent-store.js`; type JSONL records, state files, validation helpers, and public exports.
6. Migrate `lib/codex-catalog.js`; type Codex state/session records, project/chat results, and rename inputs.
7. Migrate `mcp-server.js`; type JSON-RPC envelopes, tool schemas, and tool call arguments.
8. Migrate `lib/codex-bridge.js`; type routes, app-server messages, PowerShell results, waiters, and exported internals.
9. Migrate backend tests to TypeScript or keep them as JS tests against compiled output.
10. Migrate `server.js`; type HTTP helpers, request bodies, auth/session data, speech health, and route handlers.
11. Switch runtime scripts from `node *.js` to compiled backend entry points.
12. Remove backend `node --check` coverage once `tsc --project` covers the same files.
13. Run `npm run check`, do a manual local smoke test of `npm run dev`, then commit the completed migration.
