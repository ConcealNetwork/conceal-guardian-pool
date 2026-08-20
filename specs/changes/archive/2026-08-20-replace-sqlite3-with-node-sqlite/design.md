# Design — replace sqlite3 with node:sqlite

## Context

`database.js` is the only consumer of `sqlite3`. It opens `database.db`, optionally runs `database.db.sql`, and implements three methods used by `index.js` for pool uptime accounting. Queries are small and infrequent relative to HTTP traffic.

## Decisions

| Topic | Choice | Alternatives rejected |
|-------|--------|------------------------|
| Driver | `DatabaseSync` from `node:sqlite` | Keep `sqlite3`; dual-driver flag |
| Node floor | `engines.node >=22.13.0` | `>=22.5` (needs experimental flag) |
| Caller API | Keep callbacks; `nextTick` for uptime | Fully sync; promises |
| Tests | `node:test` + temp DB path injection | No tests; Jest/Mocha |
| First tick insert | Insert `TICKS=1` | Preserve old insert-`0` (off-by-one vs approved scenarios) |
| Schema | Unchanged | Redesign tables |

## Implementation sketch

```text
database(options?) → DatabaseSync(dbPath)
  exec(schema) if sql file present
  increaseClientTick / increaseServerTick → prepare().all/run in try/catch
  getClientUptime → prepare().all → nextTick(callback)
```

## Risks / mitigations

- **Experimental API:** pin engines; watch Node release notes.
- **Blocking sync I/O:** existing workload is tiny tick updates; revisit if queries grow.
- **Test pollution:** never use production `database.db` — inject paths into a temp dir.
