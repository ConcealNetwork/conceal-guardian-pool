const rateLimit = require("express-rate-limit");
const bodyParser = require("body-parser");
const NodeCache = require("node-cache");
const database = require("./database.js");
const express = require("express");
const winston = require('winston');
const config = require("./config.json");
const moment = require('moment');
const utils = require("./utils.js");
const cors = require("cors");
const path = require("path");
const CCX = require("conceal-api");
const fs = require("fs");

// query api timeout
const apiTimeout = 3000;

// message base for winston logging
const MESSAGE = Symbol.for('message');

const logFormatter = (logEntry) => {
  const base = { timestamp: new Date() };
  const json = Object.assign(base, logEntry);
  logEntry[MESSAGE] = JSON.stringify(json);
  return logEntry;
};

const logger = winston.createLogger({
  exitOnError: false, // do not exit on handled exceptions
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(utils.ensureUserDataDir(), 'info.log'),
      maxsize: 10000000,
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: path.join(utils.ensureUserDataDir(), 'errors.log'),
      maxsize: 10000000,
      maxFiles: 5,
      level: 'error'
    })
  ],
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(utils.ensureUserDataDir(), 'exceptions.log'),
      maxsize: 10000000,
      maxFiles: 5
    })
  ],
  format: winston.format(logFormatter)()
});

// update node data limiter
const updateNodeLimier = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30, // limit each IP to 15 requests per windowMs
  message: "Too many requests created from this IP, please try again later",
  handler : function (req, res, next, options) {
    logger.error(`Denied update node request because of to many requests in short period from IP ${req.ip}`);
    res.status(options.statusCode).send(options.message);
  }
});

// update node data limiter
const listNodesLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 300, // limit each IP to 15 requests per windowMs
  message: "Too many requests created from this IP, please try again later",
  handler : function (req, res, next, options) {
    logger.error(`Denied list nodes request because of to many requests in short period from IP ${req.ip}`);
    res.status(options.statusCode).send(options.message);
  }
});

var nodeCache = new NodeCache({ stdTTL: config.cache.expire, checkperiod: config.cache.checkPeriod }); // the cache object
var storage = new database(); // create a new storage instance
var app = express(); // create express app

// cache for last uptime check
var updateCache = {};

// attach other libraries to the express application
app.enable("trust proxy", '127.0.0.1');
app.use(bodyParser.json());
app.use(cors());

// handle any application errors
app.use(function (err, req, res, next) {
  if (err) {
    logger.error('Error trying to execute request!', err);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// start listener
app.listen(config.server.port, () => {
  console.log(`Server running on port ${config.server.port}`);
});

function getAllNodes(keys) {
  let nodeList = [];

  keys.forEach(function (value) {
    let nodeData = nodeCache.get(value);

    if (nodeData) {
      nodeList.push(nodeCache.get(value));
    }
  });

  return nodeList;
}

function filterResults(req, values) {
  var correctHeightList = {};
  var correctHeightCnt = 0;
  var filteredValues = [];
  var correctHeight = 0;
  var isSyncedOnly = true

  if (req.query.isSynced) {
    isSyncedOnly = req.query.isSynced.toUpperCase() == "TRUE";
  }

  filteredValues = values.filter((value, index, array) => {
    var isAppropriate = true;

    if (req.query.hasFeeAddr) {
      var hasFeeAddress = value.blockchain && value.blockchain.fee_address;
      isAppropriate = isAppropriate && (((req.query.hasFeeAddr === "true") && hasFeeAddress) || ((req.query.hasFeeAddr === "false") && !hasFeeAddress));
    }

    if (req.query.isReachable) {
      var isReachable = value.status && value.status.isReachable;
      isAppropriate = isAppropriate && (((req.query.isReachable === "true") && isReachable) || ((req.query.isReachable === "false") && !isReachable));
    }

    if (req.query.hasSSL) {
      var hasSSL = value.status && value.status.hasSSL;
      isAppropriate = isAppropriate && (((req.query.hasSSL === "true") && hasSSL) || ((req.query.hasSSL === "false") && !hasSSL));
    }

    var nodeHeight = value.blockchain ? value.blockchain.height : 0;
    correctHeightList[nodeHeight] = (correctHeightList[nodeHeight] || 0) + 1;

    return isAppropriate;
  });

  // find the correct height
  for (var propertyName in correctHeightList) {
    if (correctHeightList[propertyName] > correctHeightCnt) {
      correctHeightCnt = correctHeightList[propertyName];
      correctHeight = propertyName;
    }
  }

  if (isSyncedOnly) {
    filteredValues = filteredValues.filter((value, index, array) => {
      var nodeHeight = value.blockchain ? value.blockchain.height : 0;
      return nodeHeight >= correctHeight - 2;
    });
  }

  return filteredValues;
}

function setNodeData(data, callback) {
  storage.getClientUptime({ id: [data.id], year: [moment().year()], month: [moment().month() + 1] }, function (resultData) {
    data.status.lastSeen = moment().toISOString();
    let nodeData = nodeCache.get(data.id);
    let doCheckReachable = false;

    if (resultData && resultData.uptimes && (resultData.uptimes.length == 1)) {
      data.status.uptime = Math.round((resultData.uptimes[0].clientTicks / resultData.uptimes[0].serverTicks) * 100);
    }

    // do we need to check it
    if (!updateCache[data.id] || !nodeData) {
      doCheckReachable = true;
    } else {
      doCheckReachable = moment.duration(moment(new Date()).diff(moment(updateCache[data.id]))).asMinutes() > 60;
    }

    if (doCheckReachable) {
      updateCache[data.id] = moment().toISOString();

      let CCXApiSSL = new CCX({
        daemonHost: `https://${data.url ? data.url.host : data.nodeHost}`, 
        daemonRpcPort: data.url ? data.url.port : data.nodePort,
        timeout: apiTimeout
      });

      // check SSL connection first
      CCXApiSSL.info().then(data => {
        data.status.hasSSL = true;
        data.status.isReachable = true;
        callback(nodeCache.set(data.id, data, config.cache.expire));          
      }).catch(err => {
        let CCXApi = new CCX({
          daemonHost: `http://${data.url ?data.url.host : data.nodeHost}`, 
          daemonRpcPort: data.url ? data.url.port : data.nodePort,
          timeout: apiTimeout
        });

        // check unsecure connection
        CCXApi.info().then(data => {
          data.status.hasSSL = false;  
          data.status.isReachable = true;
          callback(nodeCache.set(data.id, data, config.cache.expire));          
        }).catch(err => {
          data.status.hasSSL = false;  
          data.status.isReachable = false;
          callback(nodeCache.set(data.id, data, config.cache.expire));          
        });
      });
    } else {
      data.status.hasSSL = nodeData.status.hasSSL;
      data.status.isReachable = nodeData.status.isReachable;      
      callback(nodeCache.set(data.id, data, config.cache.expire));
    }
  });
}

// update uptime for nodes
function checkNodesUptimeStatus() {
  let keys = nodeCache.keys();

  for (let key of keys) {
    var nodeData = nodeCache.get(key);

    if (nodeData) {
      var lastSeen = moment(nodeData.status.lastSeen);

      if (moment.duration(moment(new Date()).diff(lastSeen)).asMinutes() < config.uptime.period) {
        storage.increaseClientTick(key);
      }
    }
  }

  // increase the server tick count
  storage.increaseServerTick();
}

// get request for the list of all active nodes
app.get("/pool/list", listNodesLimiter, (req, res) => {
  res.json({ success: true, list: filterResults(req, getAllNodes(nodeCache.keys())) });
});

// count all active nodes by specified filters
app.get("/pool/count", listNodesLimiter, (req, res) => {
  res.json({ success: true, count: filterResults(req, getAllNodes(nodeCache.keys())).length });
});

// get the random node back to user
app.get("/pool/random", listNodesLimiter, (req, res, next) => {
  var nodeList = filterResults(req, getAllNodes(nodeCache.keys()));
  var randomNode = nodeList[Math.floor(Math.random() * nodeList.length)];

  if (randomNode) {
    res.json({ success: true, url: vsprintf("%s:%d", [(randomNode.url && randomNode.url.host) ? randomNode.url.host : randomNode.nodeHost, (randomNode.url && randomNode.url.port) ? randomNode.url.port : randomNode.nodePort || 16000]) });
  } else {
    res.json({ success: false });
  }
});

// post request for updating the node data
app.post("/pool/update", updateNodeLimier, (req, res, next) => {
  if ((req.body) && (req.body.id) && (req.body.nodeHost) && (req.body.nodePort)) {
    setNodeData(req.body, function (result) {
      res.json({ success: result });
    });
  } else {
    res.json({ success: false }); 
  }
});

// post request for updating the node data
app.all("/pool/uptime", listNodesLimiter, (req, res, next) => {
  if (req.body) {
    storage.getClientUptime(req.body, function (resultData) {
      res.json(resultData);
    });
  }
});

// get request for the list of all active nodes
app.get("/pool/stats", listNodesLimiter, (req, res) => {
  res.json(nodeCache.getStats());
});

// set the interval for the uptime check of all nodes
setInterval(checkNodesUptimeStatus, config.uptime.period * 1000);