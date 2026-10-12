# Architecture

[English](architecture.md) · [简体中文](architecture.zh-CN.md)

Follow Garden is a Manifest V3 extension with a static product website. The extension has no developer backend and no production dependencies.

## Components

- `extension/ui/`: bilingual management page and toolbar popup. User actions use a narrow extension message interface.
- `extension/src/background.js`: initializes settings, readers, connection observation and the local service.
- `service.js` and `domain.js`: account-scoped state, relationship evidence, protection and review eligibility, refresh previews and persistence.
- `session.js`, `connection.js`, `request-observer.js`, `list-transport.js`: temporary X-session observation, identity checks and fixed read-only requests in the connected X tab.
- `twitter-api.js` and `read-settings.js`: optional provider key storage, independent request authentication, queued reads and pagination.
- `runner.js`: confirmed unfollow tasks, sequential relationship rechecks, pause/cancel and uncertain-result recovery.

## Data flow

The top-level refresh reads following, then followers. Pages appear in an in-memory preview; cancellation restores the old snapshot. Complete data requires an explicit server end marker, not a small or empty page. Read errors preserve clearly marked partial results where supported.

Free mode reuses X's signed-in browser session. Following and followers use direct paginated profile reads, requesting up to 200 profiles per page. Provider mode reads full profiles, derives IDs from those profiles and does not make a redundant ID-list request during a full refresh. Provider reads are paced and billed externally.

## Invariants

- IDs remain strings. Missing data stays unknown.
- Incomplete follower sets cannot prove absence. Protection is independent of relationship classification.
- Protected and unknown accounts cannot enter review candidates.
- Accounts are rechecked during reads and before writes; account changes stop the operation.
- Writes require explicit confirmation. Uncertain writes are never automatically replayed.
- Authentication is not included in snapshots, exports or logs. Optional provider keys have separate trusted extension storage.
- No remotely hosted JavaScript is executed. Responses are treated as data; profile avatars are restricted to the X image CDN.

## Validation

`npm test` covers synthetic domain, session, provider, service and task scenarios. `npm run check` validates public documents, manifest, local assets and language coverage. `npm run package` builds a reproducible extension ZIP. Live requests and Chrome Web Store approval remain separate verification steps.
