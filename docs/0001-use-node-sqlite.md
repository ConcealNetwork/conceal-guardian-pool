# 0001. Use Node built-in SQLite for pool uptime storage

- **Status**: Accepted
- **Date**: 2026-08-20
- **Area**: storage / runtime
- **Related**: specs/changes/archive/2026-08-20-replace-sqlite3-with-node-sqlite/, ADR-0001

## Context

Uptime accounting used the native `sqlite3` npm addon, which adds install/build friction for a small on-disk store. Node 22.13+ ships `node:sqlite` (`DatabaseSync`) without an experimental CLI flag.

## Decision

Persist pool uptime data with Node’s built-in `node:sqlite` (`DatabaseSync`). Do not depend on the `sqlite3` npm package. Require Node `>=22.13.0`. Keep the existing callback-shaped storage API for app callers.

## Alternatives considered

- **Keep `sqlite3`** — rejected: native build cost for little gain at this scale.
- **Dual-driver / feature flag** — rejected: unnecessary complexity.
- **Engines `>=22.5` with `--experimental-sqlite`** — rejected: worse ops story than 22.13+.

## Consequences

### Positive
- Simpler installs; one fewer native dependency.
- Same on-disk schema and HTTP uptime surface.

### Negative
- `node:sqlite` is still experimental (runtime warning until Node stabilizes it).
- Sync DB I/O on the event loop (acceptable for current tick volume).

### Neutral
- First tick for a new year/month inserts `TICKS=1` (corrects prior insert-`0` off-by-one).

## References

- Archive: `specs/changes/archive/2026-08-20-replace-sqlite3-with-node-sqlite/`
- Capability: `specs/storage/spec.md`
