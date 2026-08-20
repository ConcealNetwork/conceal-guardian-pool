'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const moment = require('moment');
const database = require('../database');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgp-e2e-'));
const dbPath = path.join(dir, 'database.db');
const schemaPath = path.join(dir, 'database.db.sql');
fs.copyFileSync(path.join(__dirname, '..', 'database.db.sql'), schemaPath);

const storage = new database({ dbPath, schemaPath });
const nodeId = 'e2e-node-1';

storage.increaseServerTick();
storage.increaseClientTick(nodeId);

storage.getClientUptime(
  { id: [nodeId], year: [moment().year()], month: [moment().month() + 1] },
  (result) => {
    try {
      if (!result || !Array.isArray(result.uptimes) || result.uptimes.length !== 1) {
        throw new Error('expected one uptime row, got ' + JSON.stringify(result));
      }
      const row = result.uptimes[0];
      if (row.id !== nodeId || row.clientTicks < 1 || row.serverTicks < 1) {
        throw new Error('unexpected uptime values: ' + JSON.stringify(row));
      }
      console.log('E2E_STORAGE_OK');
      process.exitCode = 0;
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
