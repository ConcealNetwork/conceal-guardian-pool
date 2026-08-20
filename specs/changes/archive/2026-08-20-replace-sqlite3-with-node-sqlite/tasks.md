# Tasks

## 1. Package and engines
- [x] 1.1 Update `package.json`: remove `sqlite3`, add `"engines": { "node": ">=22.13.0" }`, set `"test": "node --test test/*.test.js"`. Refresh lockfile so `sqlite3` is gone. Verify: `npm ls sqlite3` fails / package absent.

## 2. Storage rewrite (TDD)
- [x] 2.1 Add failing tests in `test/database.test.js` for: schema init; server tick; client tick + uptime join; invalid `nodeId` rejected; `getClientUptime` callback deferred via async turn. Verify: `npm test` fails before implementation (or red on missing module/API).
- [x] 2.2 Rewrite `database.js` to `DatabaseSync`, optional `{ dbPath, schemaPath }`, preserve method signatures and validation/SQL. Verify: `npm test` passes.

## 3. Smoke and product loop
- [x] 3.1 Confirm default construction (`new database()`) still works for app wiring; add `scripts/e2e-storage-loop.js` driving produce ticks → `getClientUptime` assert. Wire `e2e.json` steps. Verify: `forge e2e run` green.
