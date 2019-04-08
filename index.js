// redisDemo.js
const bodyParser = require("body-parser");
const NodeCache = require("node-cache");
const vsprintf = require("sprintf-js").vsprintf;
const express = require("express");
const winston = require('winston');
const config = require("./config.json");
const utils = require("./utils.js");
const shell = require("shelljs");
const Ddos = require('ddos');
const cors = require("cors");
const path = require("path");
const CCX = require("conceal-js");
const fs = require("fs");

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
    new transports.File({
      filename: path.join(utils.ensureUserDataDir(), 'exceptions.log'),
      maxsize: 10000000,
      maxFiles: 5
    })
  ]
});

// log the denial requests for pool
const onDenial = function (req) {
  logger.error('Denied request because of DDOS detection!');
};

var nodeCache = new NodeCache({ stdTTL: config.cache.expire, checkperiod: config.cache.checkPeriod }); // the cache object
var ddos = new Ddos({ burst: 5, limit: 15, onDenial });
var app = express(); // create express app

// attach other libraries to the express application
app.use(bodyParser.json());
app.use(ddos.express);
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
    if (req.query.hasFeeAddr) {
      return ((req.query.hasFeeAddr === "true") && (value.blockchain && value.blockchain.fee_address)) || ((req.query.hasFeeAddr === "false") && !(value.blockchain && value.blockchain.fee_address));
    }

    return true;
  });
}

// get request for the list of all active nodes
app.get("/pool/list", (req, res) => {
  nodeCache.keys(function (err, keys) {
    if (!err) {
      res.json({ success: true, list: filterResults(req, getAllNodes(keys)) });
    } else {
      res.json({ success: false, list: [] });
    }
  });
});

// get the random node back to user
app.get("/pool/random", (req, res, next) => {
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
app.post("/pool/update", (req, res, next) => {
  if ((req.body) && (req.body.id) && (req.body.nodeHost) && (req.body.nodePort)) {
    // check if node is already in pool
    if (!nodeCache.get(req.body.id)) {
      // initialize the conceal API with the client IP and daemon port
      var CCXApi = new CCX(vsprintf("http://%s", [req.body.nodeHost]), "3333", req.body.nodePort);

      // if first request check if alive
      CCXApi.info().then(data => {
        logger.info('New node has been registered to the pool', req.body);

        res.json({
          success: nodeCache.set(req.body.id, req.body, config.cache.expire)
        });
      }).catch(err => {
        res.json({
          success: false
        });
      });
    } else {
      res.json({
        success: nodeCache.set(req.body.id, req.body, config.cache.expire)
      });
    }
  }
});