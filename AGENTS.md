# Agent Instructions

This is a stable Bun rendering service for HyperFrames videos. Make changes conservatively and keep behavior documented.

## Required Reading

Before changing code, read:

- `README.md` for public usage and API contract
- `ARCHITECTURE.md` for internal flow and file ownership

## Documentation Must Stay Current

Whenever a code change affects public usage, update `README.md`.

Examples:

- commands
- environment variables
- endpoints
- payload fields
- validation rules
- example payload expectations

Whenever a code change affects internals, update `ARCHITECTURE.md`.

Examples:

- strategy flow
- render flow
- asset preparation
- shared helpers
- job lifecycle
- file ownership
- generated workspace behavior

Do not leave docs stale after code changes.

## Self-Learning Rule

When you discover a durable fact about this codebase, add it to the right document before finishing the task.

Durable facts include:

- a validation rule that is enforced by code
- a route behavior
- a strategy-specific convention
- a generated file or folder behavior
- an environment variable dependency
- a render pipeline constraint
- a media handling rule
- a cleanup decision, such as removed legacy behavior

Use this split:

- Put public usage facts in `README.md`.
- Put internal implementation facts in `ARCHITECTURE.md`.
- Put agent workflow expectations in `AGENTS.md`.

Do not add temporary observations, guesses, debug notes, or task-specific dead ends. Only document facts that future maintainers or agents should rely on.

If you remove or replace behavior, also remove or update any old documentation that described the previous behavior.

## Payload Contract

Only these payload types are valid:

- `L1L2`
- `L3L4`

Use `scenes`, not `sections`.

Every payload requires:

- `type`
- `id`
- `callbackUrl`
- at least one of `intro`, `outro`, `titleCard`, or `scenes`

`logo` and `bgMusic` cannot be sent alone.

`POST /render` is asynchronous: it responds `202` immediately and POSTs the
result (`status`, `uploadedKey`, ...) to `callbackUrl` when the render finishes.
A missing `callbackUrl` is rejected with `422`. The payload's `type` and an
optional `callbackId` are echoed back in the callback so the caller can route the
result without parsing the URL (the renderer never interprets `callbackId`). The
callback is fire-and-forget with no retries; the result is also pollable at
`GET /status/:jobId`.

`titleCard` requires both:

- `vidSrc`
- `titleText`

## Development Notes

- Keep `server.js` as the only server entrypoint.
- Keep shared helpers in `common/`.
- Keep strategy-specific payload validation and asset preparation inside `strategies/l1l2/` and `strategies/l3l4/`.
- Do not reintroduce post-render intro/outro stitching.
- Do not reintroduce root `hyperframes.json` or `meta.json`.
- Generated folders are not source: `.jobs/`, `.asset-cache/`, `renders/`.

## Verification

After code changes, run the smallest useful checks.

For syntax/import checks:

```bash
bun -e "await import('./server.js').catch(e => { if (!String(e).includes('EADDRINUSE')) throw e; })"
```

For strategy validation checks, import the strategy modules directly.

For generated composition behavior, use the service with a representative payload.
