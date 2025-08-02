const sqlite3 = require('sqlite3');
const appRoot = require('app-root-path');
const moment = require('moment');
const path = require('path');
const fs = require('fs');

function database() {
  var db = new sqlite3.Database(path.join(appRoot.path, "database.db"), sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
      console.log('Could not connect to database', err);
    } else {
      if (fs.existsSync(path.join(appRoot.path, "database.db.sql"), 'utf8')) {
        db.exec(fs.readFileSync(path.join(appRoot.path, "database.db.sql"), 'utf8'), function (err) {
          if (err) {
            console.log('Error intializing database', err);
          }
        });
      }
    }
  });

  function replaceAll(str, find, replace) {
    return str.replace(new RegExp(find, 'g'), replace);
  }  

  this.increaseClientTick = function (nodeId) {
    // Validate nodeId to prevent SQL injection
    if (!nodeId || typeof nodeId !== 'string' || nodeId.length > 100) {
      console.log("Invalid nodeId provided to increaseClientTick:", nodeId);
      return;
    }
    
    // Sanitize nodeId - only allow alphanumeric, hyphens, and underscores
    if (!/^[a-zA-Z0-9\-_]+$/.test(nodeId)) {
      console.log("Invalid nodeId format:", nodeId);
      return;
    }

    var selectSQL = "SELECT * FROM uptime_client WHERE (NODE = ?) AND (YEAR = ?) AND (MONTH = ?)";
    var insertSQL = "INSERT INTO uptime_client(NODE, YEAR, MONTH, TICKS) VALUES(?, ?, ?, 0)";
    var updateSQL = "UPDATE uptime_client SET TICKS = TICKS + 1 WHERE (NODE = ?) AND (YEAR = ?) AND (MONTH = ?)";

    db.all(selectSQL, [nodeId, moment().year(), moment().month() + 1], function (err, rows) {
      if (err) {
        console.log("Error updating the client node tick", err);
      } else {
        if (rows.length > 0) {
          db.run(updateSQL, [nodeId, moment().year(), moment().month() + 1], function (err) {
            if (err) {
              console.log("Error updating the client node tick", err);
            }
          });
        } else {
          db.run(insertSQL, [nodeId, moment().year(), moment().month() + 1], function (err) {
            if (err) {
              console.log("Error updating the client node tick", err);
            }
          });
        }
      }
    });
  };

  this.increaseServerTick = function () {
    var selectSQL = "SELECT * FROM uptime_server WHERE (YEAR = ?) AND (MONTH = ?)";
    var insertSQL = "INSERT INTO uptime_server(YEAR, MONTH, TICKS) VALUES(?, ?, 0)";
    var updateSQL = "UPDATE uptime_server SET TICKS = TICKS + 1 WHERE (YEAR = ?) AND (MONTH = ?)";

    db.all(selectSQL, [moment().year(), moment().month() + 1], function (err, rows) {
      if (err) {
        console.log("Error updating the server node tick", err);
      } else {
        if (rows.length > 0) {
          db.run(updateSQL, [moment().year(), moment().month() + 1], function (err) {
            if (err) {
              console.log("Error updating the server node tick", err);
            }
          });
        } else {
          db.run(insertSQL, [moment().year(), moment().month() + 1], function (err) {
            if (err) {
              console.log("Error updating the server node tick", err);
            }
          });
        }
      }
    });
  };

  this.getClientUptime = function (params, callback) {
    // Use a completely static query structure to prevent SQL injection
    var selectSQL = `SELECT uptime_client.NODE as 'id', 
                            sum(uptime_client.TICKS) as 'clientTicks',   
                            sum(uptime_server.TICKS) as 'serverTicks'
                     FROM uptime_client 
                     LEFT JOIN uptime_server ON                      
                     (uptime_client.YEAR = uptime_server.YEAR) AND
                     (uptime_client.MONTH = uptime_server.MONTH)
                     WHERE uptime_client.NODE = ? AND uptime_client.YEAR = ? AND uptime_client.MONTH = ?
                     GROUP BY uptime_client.NODE`;

    // Extract and validate parameters with safe defaults
    var nodeId = null;
    var year = moment().year();
    var month = moment().month() + 1;

    if (params.id && Array.isArray(params.id) && params.id.length > 0) {
      nodeId = params.id[0];
    }

    if (params.year && Array.isArray(params.year) && params.year.length > 0) {
      year = params.year[0];
    }

    if (params.month && Array.isArray(params.month) && params.month.length > 0) {
      month = params.month[0];
    }

    var queryParams = [nodeId, year, month];

    db.all(selectSQL, queryParams, function (err, rows) {
      if (err) {
        console.log("Error getting the uptime data", err);
        callback({});
      } else {
        var resultData = {
          uptimes: []
        };

        for (var i = 0, len = rows.length; i < len; i++) {
          resultData.uptimes.push(rows[i]);
        }

        callback(resultData);
      }
    });
  };
}

module.exports = database;