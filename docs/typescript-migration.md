# TypeScript Migration

Status: the backend source now lives in TypeScript and compiles to `dist/server`.

1. Keep source changes in `server.ts`, `mcp-server.ts`, and `lib/**/*.ts`.
2. Run `npm run typecheck:backend` for backend-only type checks.
3. Run `npm run backend:build` before launching compiled backend entry points directly.
4. Use `node dist/server/server.js` for the HTTP server after a build.
5. Use `node dist/server/mcp-server.js` for MCP host configuration after a build.
6. Keep `npm run check` green before committing backend changes.
