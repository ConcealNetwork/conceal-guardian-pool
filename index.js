// redisDemo.js
const bodyParser = require("body-parser");
const NodeCache = require("node-cache");
const express = require("express");
const config = require("./config.json");
const cors = require("cors");

var nodeCache = new NodeCache({ stdTTL: config.cache.expire, checkperiod: config.cache.checkPeriod }); // the cache object
var app = express(); // create express app
// use the json parser for body
app.use(bodyParser.json());
app.use(cors());

// start listener
app.listen(config.server.port, () => {
  console.log("Server running on port " + config.server.port);
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

// post request for updating the node data
app.post("/pool/update", (req, res) => {
  if (req.body) {
    res.json({
      success: nodeCache.set(req.body.id, req.body, 600)
    });
  }
});

// handle any application errors
app.use(function (err, req, res, next) {
  if (err) {
    next(err);
  }
});