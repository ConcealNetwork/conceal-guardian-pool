const vsprintf = require("sprintf-js").vsprintf;
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

  this.increaseClientTick = function (nodeId) {
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
    var selectSQL = `SELECT uptime_client.NODE as 'id', 
                            uptime_client.YEAR as 'year',   
                            uptime_client.MONTH as 'month',   
                            uptime_client.TICKS as 'clientTicks',   
                            uptime_server.TICKS as 'serverTicks'   
                     FROM uptime_client 
                     LEFT JOIN uptime_server ON 
                     (uptime_client.YEAR = uptime_server.YEAR) AND
                     (uptime_client.MONTH = uptime_server.MONTH)`;
    var paramList = [];

    if (params.id) {
      var idArrayAsStr = JSON.stringify(params.id);
      idArrayAsStr = idArrayAsStr.replace("[", "(");
      idArrayAsStr = idArrayAsStr.replace("]", ")");
      paramList.push(vsprintf('(uptime_client.NODE IN %s)', [idArrayAsStr]));
    }

    if (params.year) {
      paramList.push(vsprintf('(uptime_client.YEAR = %d)', [params.year]));
    }

    if (params.month) {
      paramList.push(vsprintf('(uptime_client.MONTH = %d)', [params.month]));
    }

    if (paramList.length > 0) {
      selectSQL = selectSQL + " WHERE " + paramList.join(" AND ");
    }

    db.all(selectSQL, [], function (err, rows) {
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