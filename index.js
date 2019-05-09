const rateLimit = require("express-rate-limit");
const bodyParser = require("body-parser");
const NodeCache = require("node-cache");
const vsprintf = require("sprintf-js").vsprintf;
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
  onLimitReached: function (req, res, options) {
    logger.error(vsprintf('Denied update node request because of to many requests in short period from IP %s', [req.ip]));
  }
});

// update node data limiter
const listNodesLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 300, // limit each IP to 15 requests per windowMs
  message: "Too many requests created from this IP, please try again later",
  onLimitReached: function (req, res, options) {
    logger.error(vsprintf('Denied list nodes request because of to many requests in short period from IP %s', [req.ip]));
  }
});

var nodeCache = new NodeCache({ stdTTL: config.cache.expire, checkperiod: config.cache.checkPeriod }); // the cache object
var storage = new database(); // create a new storage instance
var app = express(); // create express app

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
  console.log(vsprintf("Server running on port %d", [config.server.port]));
});

function getAllNodes(keys) {
  var nodeList = [];

  keys.forEach(function (value) {
    nodeList.push(nodeCache.get(value));
  });

  return nodeList;
}

function filterResults(req, values) {
  return values.filter((value, index, array) => {
    var isAppropriate = true;

    if (req.query.hasFeeAddr) {
      var hasFeeAddress = value.blockchain && value.blockchain.fee_address;
      isAppropriate = isAppropriate && (((req.query.hasFeeAddr === "true") && hasFeeAddress) || ((req.query.hasFeeAddr === "false") && !hasFeeAddress));
    }

    if (req.query.isReachable) {
      var isReachable = value.status && value.status.isReachable;
      isAppropriate = isAppropriate && (((req.query.isReachable === "true") && isReachable) || ((req.query.isReachable === "false") && !isReachable));
    }

    return isAppropriate;
  });
}

function setNodeData(data, isReachable) {
  data.status.isReachable = isReachable;
  data.status.lastSeen = moment().toISOString();
  return nodeCache.set(data.id, data, config.cache.expire);
}

// update uptime for nodes
function checkNodesUptimeStatus() {
  nodeCache.keys(function (err, keys) {
    if (!err) {
      for (var key of keys) {
        var nodeData = nodeCache.get(key);
        var lastSeen = moment(nodeData.status.lastSeen);

        if (moment.duration(moment(new Date()).diff(lastSeen)).asMinutes() < config.uptime.period) {
          storage.increaseClientTick(key);
        }
      }
    }
  });

  // increase the server tick count
  storage.increaseServerTick();
}

// get request for the list of all active nodes
app.get("/pool/list", listNodesLimiter, (req, res) => {
  nodeCache.keys(function (err, keys) {
    if (!err) {
      res.json({ success: true, list: filterResults(req, getAllNodes(keys)) });
    } else {
      res.json({ success: false, list: [] });
    }
  });
});

// get the random node back to user
app.get("/pool/random", listNodesLimiter, (req, res, next) => {
  nodeCache.keys(function (err, keys) {
    if (!err) {
      var nodeList = filterResults(req, getAllNodes(keys));
      var randomNode = nodeList[Math.floor(Math.random() * nodeList.length)];

      if (randomNode) {
        res.json({ success: true, url: vsprintf("%s:%d", [randomNode.nodeHost, randomNode.nodePort]) });
      } else {
        res.json({ success: false });
      }
    } else {
      res.json({ success: false });
    }
  });
});

// post request for updating the node data
app.post("/pool/update", updateNodeLimier, (req, res, next) => {
  if ((req.body) && (req.body.id) && (req.body.nodeHost) && (req.body.nodePort)) {
    var CCXApi = new CCX(vsprintf("http://%s", [req.body.url ? req.body.url.host : req.body.nodeHost]), "3333", req.body.url ? req.body.url.port : req.body.nodePort, apiTimeout);

    CCXApi.info().then(data => {
      res.json({ success: setNodeData(req.body, true) });
    }).catch(err => {
      res.json({ success: setNodeData(req.body, false) });
    });
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

// set the interval for the uptime check of all nodes
setInterval(checkNodesUptimeStatus, config.uptime.period * 1000);