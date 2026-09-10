# Project Guidelines

This is a standalone Vue 3 + TypeScript + Pinia web application with a Node API. Preserve the existing light theme and non-serializable resource boundaries.

## Source map

- `src/ui/main.ts`, `App.vue`: the single application entry and shared Pinia instance.
- `components/`: Vue-owned views. No legacy page wrapper, global bootstrap API, business HTML strings, or v-html application shell.
- `stores/workspace.ts`: typed workspace, image/slice models, selection and undo/redo. Preserve v1 draft compatibility.
- `stores/ai-tasks.ts`: task ownership; controllers remain outside persisted state.
- `composables/`: editor and batch lifecycle, cancellation and stale response checks.
- `api/client.ts`: relative local API requests. Never store credentials in a workspace.
- `services/`, `state/`, `src/core/`: reusable algorithms. Shared pure functions have one ESM implementation; Node uses synchronous ESM interop.
- `server.js`, `src/server/`: Node API, providers, configuration, draft storage and local workers.
- `index.html`: Vite mount node only. `dist/` is generated, ignored, and never hand edited.

## Changes

Keep Vue state and template ownership together. Use refs and lifecycle cleanup for Canvas/DOM/listeners. Never add another Pinia root or restore the removed plugin/simulator bridges.
Preserve asset ID, design geometry, pixel metadata and history schema. Async writes must check workspace/version, ignore late responses, and roll back failed asset commits and undo stacks.
Do not move or delete model directories, virtual environments, credentials or historical data when changing the UI.

## Validation

Run `npm test`, `npm run test:e2e`, `npm run build`, and `git diff --check`.
E2E accesses the Vue root with mocked APIs and in-memory drafts. Do not silently call paid models.
`npm run dev` / `npm start` runs API + Vite HMR on 4173. `npm run preview` runs API + built preview, requiring a prior build.
Check desktop and narrow layouts and modal keyboard focus. See `docs/vue-migration.md`.
