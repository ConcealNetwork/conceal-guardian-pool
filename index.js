// redisDemo.js
const rateLimit = require("express-rate-limit");
const bodyParser = require("body-parser");
const NodeCache = require("node-cache");
const vsprintf = require("sprintf-js").vsprintf;
const express = require("express");
const winston = require('winston');
const config = require("./config.json");
const utils = require("./utils.js");
const cors = require("cors");
const path = require("path");
const CCX = require("conceal-api");
const fs = require("fs");

// query api timeout
const apiTimeout = 3000;

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
  ]
});

// update node data limiter
const updateNodeLimier = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 15, // limit each IP to 15 requests per windowMs
  message: "Too many requests created from this IP, please try again later",
  onLimitReached: function (req, res, options) {
    remoteIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    logger.error(vsprintf('Denied update node request because of to many requests in short period from IP %s', [remoteIP]));
  }
});

// update node data limiter
const listNodesLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 300, // limit each IP to 15 requests per windowMs
  message: "Too many requests created from this IP, please try again later",
  onLimitReached: function (req, res, options) {
    remoteIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    logger.error(vsprintf('Denied list nodes request because of to many requests in short period from IP %s', [remoteIP]));
  }
});

var nodeCache = new NodeCache({ stdTTL: config.cache.expire, checkperiod: config.cache.checkPeriod }); // the cache object
var app = express(); // create express app

// attach other libraries to the express application
app.enable("trust proxy");
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
    var CCXApi = new CCX(vsprintf("http://%s", [req.body.nodeHost]), "3333", req.body.nodePort, apiTimeout);

    CCXApi.info().then(data => {
      req.body.status.isReachable = true;
      res.json({ success: nodeCache.set(req.body.id, req.body, config.cache.expire) });
    }).catch(err => {
      req.body.status.isReachable = false;
      res.json({ success: nodeCache.set(req.body.id, req.body, config.cache.expire) });
    });
  }
});