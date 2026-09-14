const rateLimit = require("express-rate-limit");
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
const updateNodeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 30, // limit each IP to 30 requests per windowMs
  message: "Too many requests created from this IP, please try again later",
  handler : function (req, res, next, options) {
    logger.error(`Denied update node request because of to many requests in short period from IP ${req.ip}`);
    res.status(options.statusCode).send(options.message);
  }
});

// update node data limiter
const listNodesLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 300, // limit each IP to 300 requests per windowMs
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
app.set("trust proxy", 1); // trust first proxy
app.use(express.json({ limit: "16kb" })); // Express v5 built-in body parser
app.use(cors({
  origin: [
    'http://explorer.conceal.network',
    'https://explorer.conceal.network',
    'http://newexplorer.conceal.network',
    'https://newexplorer.conceal.network',
    'https://wws.conceal.network',
    'https://wallet.conceal.network'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(cors({
  origin: '*',
  methods: ['GET'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));

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

// start listener (localhost only)
app.listen(config.server.port, '127.0.0.1', () => {
  console.log(`Server running on http://127.0.0.1:${config.server.port}`);
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

// node id pattern and host character set used for update validation
const nodeIdPattern = /^[a-zA-Z0-9\-_]+$/;
const hostCharsetPattern = /^[a-zA-Z0-9.\-:\[\]]+$/;

// hosts that are never accepted as node or probe targets
const blockedHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::", "::1"]);

// max height accepted in an update payload
const maxHeight = 100000000;

function isHostAllowed(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) {
    return false;
  }

  if (!hostCharsetPattern.test(host)) {
    return false;
  }

  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();

  if (blockedHosts.has(normalized)) {
    return false;
  }

  // loopback, link-local and unspecified address ranges
  return !/^127\.|^169\.254\.|^0\.|^fe80:/.test(normalized);
}

function isValidPort(port) {
  const value = Number(port);

  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function sanitizedString(value, maxLength) {
  if (typeof value !== "string") {
    return null;
  }

  return value.substring(0, maxLength);
}

function sanitizedPrimitiveMap(source, maxEntries, maxValueLength) {
  const result = {};
  let count = 0;

  for (const key of Object.keys(source)) {
    if (count >= maxEntries) {
      break;
    }

    const value = source[key];

    if (typeof value === "string") {
      result[key.substring(0, 50)] = value.substring(0, maxValueLength);
      count++;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      result[key.substring(0, 50)] = value;
      count++;
    } else if (typeof value === "boolean") {
      result[key.substring(0, 50)] = value;
      count++;
    }
  }

  return result;
}

// build a validated node record from the submitted update payload, null when rejected
function sanitizeNodeUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const id = typeof body.id === "string" ? body.id : "";
  const nodeHost = typeof body.nodeHost === "string" ? body.nodeHost : "";

  if (id.length === 0 || id.length > 100 || !nodeIdPattern.test(id)) {
    return null;
  }

  if (!isHostAllowed(nodeHost)) {
    return null;
  }

  if (!isValidPort(body.nodePort)) {
    return null;
  }

  const record = {
    id: id,
    os: sanitizedString(body.os, 50) || "",
    name: sanitizedString(body.name, 200) || "",
    version: sanitizedString(body.version, 50) || "",
    nodeHost: nodeHost,
    nodePort: Number(body.nodePort),
    status: {},
    blockchain: null,
    location: null
  };

  // optional custom url, dropped when it does not pass validation
  if (body.url && typeof body.url === "object" && !Array.isArray(body.url)) {
    if (isHostAllowed(body.url.host) && isValidPort(body.url.port)) {
      record.url = { host: body.url.host, port: Number(body.url.port) };
    } else {
      logger.warn(`Node ${id} submitted an invalid custom url, ignoring it`);
    }
  }

  if (body.status && typeof body.status === "object" && !Array.isArray(body.status)) {
    const errors = Number(body.status.errors);

    record.status = {
      errors: Number.isFinite(errors) ? errors : 0,
      startTime: sanitizedString(body.status.startTime, 50) || "",
      initialized: body.status.initialized === true
    };
  }

  if (body.blockchain && typeof body.blockchain === "object" && !Array.isArray(body.blockchain)) {
    const blockchain = {};

    // reject the update when present fields have a wrong type or an out-of-range value
    if (body.blockchain.height !== undefined) {
      const height = Number(body.blockchain.height);

      if (!Number.isFinite(height) || height < 0 || height > maxHeight) {
        return null;
      }

      blockchain.height = height;
    }

    if (body.blockchain.fee_address !== undefined) {
      const feeAddress = sanitizedString(body.blockchain.fee_address, 200);

      if (feeAddress === null) {
        return null;
      }

      blockchain.fee_address = feeAddress;
    }

    if (body.blockchain.status !== undefined) {
      const status = sanitizedString(body.blockchain.status, 100);

      if (status === null) {
        return null;
      }

      blockchain.status = status;
    }

    record.blockchain = blockchain;
  }

  if (body.location && typeof body.location === "object" && !Array.isArray(body.location)) {
    const location = {};
    const ip = sanitizedString(body.location.ip, 64);

    if (ip !== null) {
      location.ip = ip;
    }

    if (body.location.data && typeof body.location.data === "object" && !Array.isArray(body.location.data)) {
      location.data = sanitizedPrimitiveMap(body.location.data, 20, 200);
    }

    record.location = location;
  }

  return record;
}

// daemon-reported fields that are copied over the submitted node data
const daemonNumericFields = [
  "difficulty",
  "grey_peerlist_size",
  "hashrate",
  "incoming_connections_count",
  "outgoing_connections_count",
  "transactions_pool_size",
  "white_peerlist_size"
];

// height difference between submitted and daemon data that is treated as normal drift
const heightTolerance = 2;

// apply the values reported by the node daemon over the data submitted to the pool
function applyDaemonInfo(data, info) {
  if (!info || typeof info !== "object") {
    return;
  }

  if (!data.blockchain || typeof data.blockchain !== "object") {
    data.blockchain = {};
  }

  const daemonHeight = Number(info.height);

  if (Number.isFinite(daemonHeight) && daemonHeight > 0) {
    const claimedHeight = Number(data.blockchain.height);

    if (Number.isFinite(claimedHeight) && Math.abs(claimedHeight - daemonHeight) > heightTolerance) {
      logger.warn(`Node ${data.id} submitted height ${claimedHeight} but the daemon reports ${daemonHeight}, keeping the daemon value`);
    }

    data.blockchain.height = daemonHeight;
  }

  if (typeof info.fee_address === "string") {
    if ((data.blockchain.fee_address || "") !== info.fee_address) {
      logger.warn(`Node ${data.id} submitted a fee_address that does not match the daemon response, keeping the daemon value`);
    }

    data.blockchain.fee_address = info.fee_address;
  }

  if (typeof info.status === "string") {
    data.blockchain.status = info.status;
  }

  if (typeof info.version === "string") {
    data.blockchain.version = info.version;
  }

  daemonNumericFields.forEach(function (field) {
    const value = Number(info[field]);

    if (Number.isFinite(value)) {
      data.blockchain[field] = value;
    }
  });
}

// probe the node daemon, verify the submitted data against its response and store the node
function probeNode(data, callback) {
  const host = data.url ? data.url.host : data.nodeHost;
  const port = data.url ? data.url.port : data.nodePort;

  const finish = function (hasSSL, isReachable) {
    data.status.hasSSL = hasSSL;
    data.status.isReachable = isReachable;
    callback(nodeCache.set(data.id, data, config.cache.expire));
  };

  // only probe host:port targets that pass validation
  if (!isHostAllowed(host) || !isValidPort(port)) {
    logger.warn(`Skipping the probe for node ${data.id} because of an invalid host or port`);
    finish(false, false);
    return;
  }

  let CCXApiSSL = new CCX({
    daemonHost: `https://${host}`,
    daemonRpcPort: port,
    timeout: apiTimeout
  });

  // check SSL connection first
  CCXApiSSL.info().then(info => {
    applyDaemonInfo(data, info);
    finish(true, true);
  }).catch(err => {
    let CCXApi = new CCX({
      daemonHost: `http://${host}`,
      daemonRpcPort: port,
      timeout: apiTimeout
    });

    // check unsecure connection
    CCXApi.info().then(info => {
      applyDaemonInfo(data, info);
      finish(false, true);
    }).catch(err => {
      finish(false, false);
    });
  });
}

function setNodeData(data, callback) {
  storage.getClientUptime({ id: [data.id], year: [moment().year()], month: [moment().month() + 1] }, function (resultData) {
    data.status.lastSeen = moment().toISOString();
    let nodeData = nodeCache.get(data.id);
    let doCheckReachable = false;

    if (resultData && resultData.uptimes && (resultData.uptimes.length == 1)) {
      const clientTicks = resultData.uptimes[0].clientTicks || 0;
      const serverTicks = resultData.uptimes[0].serverTicks || 1; // Prevent division by zero
      data.status.uptime = Math.round((clientTicks / serverTicks) * 100);
    } else {
      data.status.uptime = 0; // Default to 0 if no uptime data
    }

    // do we need to check it
    if (!updateCache[data.id] || !nodeData) {
      doCheckReachable = true;
    } else {
      doCheckReachable = moment.duration(moment(new Date()).diff(moment(updateCache[data.id]))).asMinutes() > 15;
    }

    if (doCheckReachable) {
      updateCache[data.id] = moment().toISOString();

      probeNode(data, callback);
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
    let host = (randomNode.url && randomNode.url.host) ? randomNode.url.host : randomNode.nodeHost;
    let port = (randomNode.url && randomNode.url.port) ? randomNode.url.port : randomNode.nodePort || 16000;

    // Extract host by retaining components before first "/"
    if (host && host.includes('/')) {
      host = host.split('/')[0];
    }

    res.json({ 
      success: true, 
      url: `${host}:${port}` 
    });
  } else {
    res.json({ success: false });
  }
});

// post request for updating the node data
app.post("/pool/update", updateNodeLimiter, (req, res, next) => {
  const record = sanitizeNodeUpdate(req.body);

  if (record) {
    setNodeData(record, function (result) {
      res.json({ success: result });
    });
  } else {
    logger.warn("Rejected an update request with an invalid payload");
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