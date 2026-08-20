'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const moment = require('moment');

const database = require('../database');

function makeTempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgp-db-'));
  const dbPath = path.join(dir, 'database.db');
  const schemaPath = path.join(dir, 'database.db.sql');
  fs.copyFileSync(path.join(__dirname, '..', 'database.db.sql'), schemaPath);
  return { dir, dbPath, schemaPath };
}

describe('database (node:sqlite)', () => {
  let paths;
  let storage;

  before(() => {
    paths = makeTempPaths();
    storage = new database({ dbPath: paths.dbPath, schemaPath: paths.schemaPath });
  });

  after(() => {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  });

  it('applies schema so uptime tables exist', () => {
    const db = new DatabaseSync(paths.dbPath, { readOnly: true });
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('uptime_client','uptime_server') ORDER BY name"
    ).all();
    db.close();
    assert.deepEqual(tables.map((r) => r.name), ['uptime_client', 'uptime_server']);
  });

  it('increaseServerTick creates a row with TICKS=1', () => {
    storage.increaseServerTick();
    const db = new DatabaseSync(paths.dbPath, { readOnly: true });
    const year = moment().year();
    const month = moment().month() + 1;
    const row = db.prepare(
      'SELECT TICKS FROM uptime_server WHERE YEAR = ? AND MONTH = ?'
    ).get(year, month);
    db.close();
    assert.ok(row);
    assert.equal(row.TICKS, 1);
  });

  it('increaseClientTick + getClientUptime returns joined ticks', async () => {
    const nodeId = 'node-test-1';
    storage.increaseClientTick(nodeId);

    const result = await new Promise((resolve) => {
      storage.getClientUptime(
        { id: [nodeId], year: [moment().year()], month: [moment().month() + 1] },
        resolve
      );
    });

    assert.ok(Array.isArray(result.uptimes));
    assert.equal(result.uptimes.length, 1);
    assert.equal(result.uptimes[0].id, nodeId);
    assert.equal(result.uptimes[0].clientTicks, 1);
    assert.ok(result.uptimes[0].serverTicks >= 1);
  });

  it('rejects invalid nodeId without inserting', () => {
    storage.increaseClientTick('');
    storage.increaseClientTick('bad id!');
    storage.increaseClientTick('x'.repeat(101));

    const db = new DatabaseSync(paths.dbPath, { readOnly: true });
    const count = db.prepare(
      "SELECT COUNT(*) AS c FROM uptime_client WHERE NODE IN ('', 'bad id!') OR LENGTH(NODE) > 100"
    ).get();
    db.close();
    assert.equal(count.c, 0);
  });

  it('getClientUptime callback is deferred', async () => {
    let called = false;
    storage.getClientUptime({ id: ['missing-node'] }, () => {
      called = true;
    });
    assert.equal(called, false);
    await new Promise((r) => setImmediate(r));
    assert.equal(called, true);
  });
});
