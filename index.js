// redisDemo.js
const bodyParser = require("body-parser");
const NodeCache = require("node-cache");
const vsprintf = require("sprintf-js").vsprintf;
const express = require("express");
const config = require("./config.json");
const Ddos = require('ddos');
const cors = require("cors");
const CCX = require("conceal-js");

// log the denial requests for pool
const onDenial = function (req) {
  // log it
};

var nodeCache = new NodeCache({ stdTTL: config.cache.expire, checkperiod: config.cache.checkPeriod }); // the cache object
var ddos = new Ddos({ burst: 10, limit: 15, onDenial });
var app = express(); // create express app
// use the json parser for body
app.use(bodyParser.json());
app.use(ddos.express);
app.use(cors());

// start listener
app.listen(config.server.port, () => {
  console.log(vsprintf("Server running on port %d", [config.server.port]));
});

// get request for the list of all active nodes
app.get("/pool/list", (req, res) => {
  nodeCache.keys(function (err, keys) {
    if (!err) {
      var nodeList = [];

      keys.forEach(function (value) {
        nodeList.push(nodeCache.get(value));
      });

      // return the list
      res.json({ success: true, list: nodeList });
    } else {
      res.json({ success: false, list: [] });
    }
  });
});

// get the random node back to user
app.get("/pool/random", (req, res) => {
  nodeCache.keys(function (err, keys) {
    if (!err) {
      var randomKey = keys[Math.floor(Math.random() * keys.length)];
      var randomNode = nodeCache.get(randomKey);

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
app.post("/pool/update", (req, res) => {
  if ((req.body) && (req.body.id) && (req.body.nodeHost) && (req.body.nodePort)) {
    // check if node is already in pool
    if (!nodeCache.get(req.body.id)) {
      // initialize the conceal API with the client IP and daemon port
      var CCXApi = new CCX(vsprintf("http://%s", [req.body.nodeHost]), "3333", req.body.nodePort);

      // if first request check if alive
      CCXApi.info().then(data => {
        res.json({
          success: nodeCache.set(req.body.id, req.body, 600)
        });
      }).catch(err => {
        res.json({
          success: false
        });
      });
    } else {
      res.json({
        success: nodeCache.set(req.body.id, req.body, 600)
      });
    }
  }
});

// handle any application errors
app.use(function (err, req, res, next) {
  if (err) {
    next(err);
  }
});