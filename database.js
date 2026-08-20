'use strict';

const { DatabaseSync } = require('node:sqlite');
const appRoot = require('app-root-path');
const moment = require('moment');
const path = require('path');
const fs = require('fs');

function database(options) {
  const opts = options || {};
  const dbPath = opts.dbPath || path.join(appRoot.path, 'database.db');
  const schemaPath = opts.schemaPath || path.join(appRoot.path, 'database.db.sql');

  let db;
  try {
    db = new DatabaseSync(dbPath);
    if (fs.existsSync(schemaPath)) {
      db.exec(fs.readFileSync(schemaPath, 'utf8'));
    }
  } catch (err) {
    console.log('Could not connect to database', err);
  }

  this.increaseClientTick = function (nodeId) {
    if (!nodeId || typeof nodeId !== 'string' || nodeId.length > 100) {
      console.log('Invalid nodeId provided to increaseClientTick:', nodeId);
      return;
    }

    if (!/^[a-zA-Z0-9\-_]+$/.test(nodeId)) {
      console.log('Invalid nodeId format:', nodeId);
      return;
    }

    const selectSQL = 'SELECT * FROM uptime_client WHERE (NODE = ?) AND (YEAR = ?) AND (MONTH = ?)';
    const insertSQL = 'INSERT INTO uptime_client(NODE, YEAR, MONTH, TICKS) VALUES(?, ?, ?, 1)';
    const updateSQL = 'UPDATE uptime_client SET TICKS = TICKS + 1 WHERE (NODE = ?) AND (YEAR = ?) AND (MONTH = ?)';
    const year = moment().year();
    const month = moment().month() + 1;

    try {
      const rows = db.prepare(selectSQL).all(nodeId, year, month);
      if (rows.length > 0) {
        db.prepare(updateSQL).run(nodeId, year, month);
      } else {
        db.prepare(insertSQL).run(nodeId, year, month);
      }
    } catch (err) {
      console.log('Error updating the client node tick', err);
    }
  };

  this.increaseServerTick = function () {
    const selectSQL = 'SELECT * FROM uptime_server WHERE (YEAR = ?) AND (MONTH = ?)';
    const insertSQL = 'INSERT INTO uptime_server(YEAR, MONTH, TICKS) VALUES(?, ?, 1)';
    const updateSQL = 'UPDATE uptime_server SET TICKS = TICKS + 1 WHERE (YEAR = ?) AND (MONTH = ?)';
    const year = moment().year();
    const month = moment().month() + 1;

    try {
      const rows = db.prepare(selectSQL).all(year, month);
      if (rows.length > 0) {
        db.prepare(updateSQL).run(year, month);
      } else {
        db.prepare(insertSQL).run(year, month);
      }
    } catch (err) {
      console.log('Error updating the server node tick', err);
    }
  };

  this.getClientUptime = function (params, callback) {
    const selectSQL = `SELECT uptime_client.NODE as 'id', 
                            sum(uptime_client.TICKS) as 'clientTicks',   
                            sum(uptime_server.TICKS) as 'serverTicks'
                     FROM uptime_client 
                     LEFT JOIN uptime_server ON                      
                     (uptime_client.YEAR = uptime_server.YEAR) AND
                     (uptime_client.MONTH = uptime_server.MONTH)
                     WHERE uptime_client.NODE = ? AND uptime_client.YEAR = ? AND uptime_client.MONTH = ?
                     GROUP BY uptime_client.NODE`;

    let nodeId = null;
    let year = moment().year();
    let month = moment().month() + 1;

    if (params.id && Array.isArray(params.id) && params.id.length > 0) {
      nodeId = params.id[0];
    }

    if (params.year && Array.isArray(params.year) && params.year.length > 0) {
      year = params.year[0];
    }

    if (params.month && Array.isArray(params.month) && params.month.length > 0) {
      month = params.month[0];
    }

    try {
      const rows = db.prepare(selectSQL).all(nodeId, year, month);
      const resultData = { uptimes: [] };
      for (let i = 0, len = rows.length; i < len; i++) {
        resultData.uptimes.push(rows[i]);
      }
      process.nextTick(() => callback(resultData));
    } catch (err) {
      console.log('Error getting the uptime data', err);
      process.nextTick(() => callback({}));
    }
  };
}

module.exports = database;
