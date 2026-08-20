# storage

## Requirements

### Requirement: Built-in SQLite driver
The storage layer SHALL persist uptime data using Node’s built-in `node:sqlite` (`DatabaseSync`) and SHALL NOT depend on the `sqlite3` npm package.

#### Scenario: Package has no sqlite3 dependency
- GIVEN the project `package.json` and lockfile after this change
- WHEN dependencies are inspected
- THEN `sqlite3` is not a declared or installed dependency
- AND `engines.node` requires `>=22.13.0`

### Requirement: Default database file and schema init
The storage layer SHALL open the configured SQLite database file (default: `database.db` under the app root) and, when a schema SQL file is present (default: `database.db.sql`), SHALL execute that SQL to ensure tables exist.

#### Scenario: Init applies schema SQL
- GIVEN a temporary empty database path and a copy of the project schema SQL
- WHEN a storage instance is constructed with those paths
- THEN tables `uptime_client` and `uptime_server` exist

### Requirement: Server and client tick accounting
The storage layer SHALL expose `increaseServerTick` and `increaseClientTick(nodeId)` that increment monthly tick counters for the current calendar year/month, creating the row when missing. Invalid `nodeId` values SHALL be rejected without writing.

#### Scenario: Server tick increments
- GIVEN an initialized temporary database
- WHEN `increaseServerTick` is called once
- THEN the server row for the current year/month has `TICKS` equal to 1

#### Scenario: Client tick and uptime join
- GIVEN an initialized temporary database with at least one server tick
- WHEN `increaseClientTick` is called with a valid node id
- AND `getClientUptime` is called for that id and current year/month
- THEN the callback receives an object whose `uptimes` includes matching `clientTicks` and `serverTicks`

#### Scenario: Invalid node id is rejected
- GIVEN an initialized temporary database
- WHEN `increaseClientTick` is called with an empty, oversized, or non-alphanumeric (beyond `-`/`_`) id
- THEN no `uptime_client` row is inserted for that id

### Requirement: Callback-compatible uptime API
`getClientUptime(params, callback)` SHALL invoke `callback` on a later event-loop turn (not synchronously in the same call stack) with either `{ uptimes: [...] }` or `{}` on error.

#### Scenario: Callback is deferred
- GIVEN an initialized temporary database
- WHEN `getClientUptime` is called
- THEN the callback has not run before the calling function returns
- AND the callback runs afterward with a result object
