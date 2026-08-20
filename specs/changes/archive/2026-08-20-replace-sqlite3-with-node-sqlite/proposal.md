# Replace sqlite3 with node:sqlite

## Why

The pool depends on the native `sqlite3` npm package, which needs a C/C++ toolchain and is heavier than necessary for this app’s small uptime store. Node 22.13+ ships a built-in `node:sqlite` module (`DatabaseSync`) that can open the same on-disk SQLite file without a native addon. Migrating removes install/build friction and one transitive native dependency, while keeping existing pool behavior.

## What Changes

- Rewrite `database.js` to use `require('node:sqlite').DatabaseSync` instead of `sqlite3`.
- Keep public methods (`increaseClientTick`, `increaseServerTick`, `getClientUptime(params, callback)`) so `index.js` call sites stay unchanged; defer `getClientUptime` callbacks with `process.nextTick`.
- Allow an optional DB path (and schema-SQL path as needed) for test isolation.
- Remove `sqlite3` from `package.json` / lockfile; set `"engines": { "node": ">=22.13.0" }`.
- Add a `node:test` suite covering init, ticks, uptime reads, invalid nodeId, and async callback behavior.
- Wire `"test": "node --test"` (or equivalent glob).

## Capabilities

- `storage`: persistence for client/server uptime ticks via SQLite — delta at `specs/changes/replace-sqlite3-with-node-sqlite/specs/storage/spec.md`

## Impact

- **Code:** `database.js`, `package.json`, `package-lock.json`, new test files under `test/` (or similar).
- **Runtime:** Node >=22.13 required; expect `ExperimentalWarning` for `node:sqlite` until Node stabilizes the API.
- **Data:** Same `database.db` / `database.db.sql` schema — no migration of row format.
- **Risks:** Sync DB work on the event loop (acceptable for current small queries); experimental API may change in future Node majors.

## Decision record

This change is recorded as ADR-0001 (docs/0001-use-node-sqlite.md).
