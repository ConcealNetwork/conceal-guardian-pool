// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const database = require('./database.js');
const express = require('express');
const winston = require('winston');
const config = require('./config.json');
const moment = require('moment');
const utils = require('./utils.js');
const { sanitizeNodeUpdate } = require('./sanitize.js');
const { probeNode } = require('./probe.js');
const {
  applyListingUpdate,
  listingKey,
  mustProbe,
  occupantIdForKey,
  preserveProbedChain,
  syncedNodes,
} = require('./listing-policy.js');
const { toPublicNode, toPublicUptime, resolvePrivateId } = require('./public-id.js');
const cors = require('cors');
const path = require('node:path');

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
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(utils.ensureUserDataDir(), 'errors.log'),
      maxsize: 10000000,
      maxFiles: 5,
      level: 'error',
    }),
  ],
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(utils.ensureUserDataDir(), 'exceptions.log'),
      maxsize: 10000000,
      maxFiles: 5,
    }),
  ],
  format: winston.format(logFormatter)(),
});

// update node data limiter
const updateNodeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 30, // limit each IP to 30 requests per windowMs
  message: 'Too many requests created from this IP, please try again later',
  handler: (req, res, _next, options) => {
    logger.error(
      `Denied update node request because of to many requests in short period from IP ${req.ip}`
    );
    res.status(options.statusCode).send(options.message);
  },
});

// update node data limiter
const listNodesLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 300, // limit each IP to 300 requests per windowMs
  message: 'Too many requests created from this IP, please try again later',
  handler: (req, res, _next, options) => {
    logger.error(
      `Denied list nodes request because of to many requests in short period from IP ${req.ip}`
    );
    res.status(options.statusCode).send(options.message);
  },
});

const nodeCache = new NodeCache({
  stdTTL: config.cache.expire,
  checkperiod: config.cache.checkPeriod,
}); // the cache object
const storage = new database(); // create a new storage instance
const app = express(); // create express app

// cache for last uptime check
const updateCache = {};

// attach other libraries to the express application
app.set('trust proxy', 1); // trust first proxy
app.use(express.json({ limit: '16kb' })); // Express v5 built-in body parser
app.use(
  cors({
    origin: [
      'http://explorer.conceal.network',
      'https://explorer.conceal.network',
      'http://newexplorer.conceal.network',
      'https://newexplorer.conceal.network',
      'https://wws.conceal.network',
      'https://wallet.conceal.network',
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);
app.use(
  cors({
    origin: '*',
    methods: ['GET'],
    allowedHeaders: ['Content-Type'],
    credentials: false,
  })
);

// handle any application errors
app.use((err, _req, res, _next) => {
  if (err) {
    logger.error('Error trying to execute request!', err);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// start listener (localhost only)
app.listen(config.server.port, '127.0.0.1', () => {
  console.log(`Server running on http://127.0.0.1:${config.server.port}`);
});

function getAllNodes(keys) {
  const nodeList = [];

  keys.forEach((value) => {
    const nodeData = nodeCache.get(value);

    if (nodeData) {
      nodeList.push(nodeCache.get(value));
    }
  });

  return nodeList;
}

function filterResults(req, values) {
  let isSyncedOnly = true;

  if (req.query.isSynced) {
    isSyncedOnly = req.query.isSynced.toUpperCase() === 'TRUE';
  }

  const filteredValues = values.filter((value) => {
    let isAppropriate = true;

    if (req.query.hasFeeAddr) {
      const hasFeeAddress = value.blockchain?.fee_address;
      isAppropriate =
        isAppropriate &&
        ((req.query.hasFeeAddr === 'true' && hasFeeAddress) ||
          (req.query.hasFeeAddr === 'false' && !hasFeeAddress));
    }

    if (req.query.isReachable) {
      const isReachable = value.status?.isReachable;
      isAppropriate =
        isAppropriate &&
        ((req.query.isReachable === 'true' && isReachable) ||
          (req.query.isReachable === 'false' && !isReachable));
    }

    if (req.query.hasSSL) {
      const hasSSL = value.status?.hasSSL;
      isAppropriate =
        isAppropriate &&
        ((req.query.hasSSL === 'true' && hasSSL) || (req.query.hasSSL === 'false' && !hasSSL));
    }

    return isAppropriate;
  });

  return syncedNodes(filteredValues, isSyncedOnly);
}

function setNodeData(data, callback) {
  storage.getClientUptime(
    { id: [data.id], year: [moment().year()], month: [moment().month() + 1] },
    (resultData) => {
      data.status.lastSeen = moment().toISOString();
      const nodeData = nodeCache.get(data.id);

      if (resultData?.uptimes && resultData.uptimes.length === 1) {
        const clientTicks = resultData.uptimes[0].clientTicks || 0;
        const serverTicks = resultData.uptimes[0].serverTicks || 1; // Prevent division by zero
        data.status.uptime = Math.round((clientTicks / serverTicks) * 100);
      } else {
        data.status.uptime = 0; // Default to 0 if no uptime data
      }

      const commitListing = (record, reachable, allowEvict) => {
        const result = applyListingUpdate({
          data: record,
          existing: nodeData,
          reachable,
          occupantId: allowEvict
            ? occupantIdForKey(getAllNodes(nodeCache.keys()), listingKey(record), record.id)
            : undefined,
        });

        if (!result.ok) {
          logger.warn(
            `Rejected node ${record.id} listing ${listingKey(record)} (${result.reason})`
          );
          callback(false);
          return;
        }

        if (result.evictId) {
          nodeCache.del(result.evictId);
        }

        callback(nodeCache.set(result.store.id, result.store, config.cache.expire));
      };

      if (mustProbe(nodeData, data, updateCache[data.id])) {
        probeNode(data, { logger, apiTimeout }, (probedData) => {
          updateCache[data.id] = moment().toISOString();
          commitListing(probedData, probedData.status.isReachable === true, true);
        });
      } else {
        preserveProbedChain(data, nodeData);
        data.status.hasSSL = nodeData.status.hasSSL;
        data.status.isReachable = nodeData.status.isReachable;
        commitListing(data, data.status.isReachable === true, false);
      }
    }
  );
}

// update uptime for nodes
function checkNodesUptimeStatus() {
  const keys = nodeCache.keys();

  for (const key of keys) {
    const nodeData = nodeCache.get(key);

    if (nodeData) {
      const lastSeen = moment(nodeData.status.lastSeen);

      if (moment.duration(moment(new Date()).diff(lastSeen)).asMinutes() < config.uptime.period) {
        storage.increaseClientTick(key);
      }
    }
  }

  // increase the server tick count
  storage.increaseServerTick();
}

// get request for the list of all active nodes
app.get('/pool/list', listNodesLimiter, (req, res) => {
  res.json({
    success: true,
    list: filterResults(req, getAllNodes(nodeCache.keys())).map(toPublicNode),
  });
});

// count all active nodes by specified filters
app.get('/pool/count', listNodesLimiter, (req, res) => {
  res.json({ success: true, count: filterResults(req, getAllNodes(nodeCache.keys())).length });
});

// get the random node back to user
app.get('/pool/random', listNodesLimiter, (req, res) => {
  const nodeList = filterResults(req, getAllNodes(nodeCache.keys()));
  const randomNode = nodeList[Math.floor(Math.random() * nodeList.length)];

  if (randomNode) {
    let host = randomNode.url?.host ? randomNode.url.host : randomNode.nodeHost;
    const port = randomNode.url?.port ? randomNode.url.port : randomNode.nodePort || 16000;

    // Extract host by retaining components before first "/"
    if (host?.includes('/')) {
      host = host.split('/')[0];
    }

    res.json({
      success: true,
      url: `${host}:${port}`,
    });
  } else {
    res.json({ success: false });
  }
});

// post request for updating the node data
app.post('/pool/update', updateNodeLimiter, (req, res) => {
  const record = sanitizeNodeUpdate(req.body, logger);

  if (record) {
    setNodeData(record, (result) => {
      res.json({ success: result });
    });
  } else {
    logger.warn('Rejected an update request with an invalid payload');
    res.json({ success: false });
  }
});

// post request for updating the node data
app.all('/pool/uptime', listNodesLimiter, (req, res) => {
  if (req.body) {
    const knownIds = nodeCache.keys();
    const query = { ...req.body };

    if (Array.isArray(query.id)) {
      query.id = query.id
        .map((value) => resolvePrivateId(value, knownIds) || value)
        .filter((value) => typeof value === 'string');
    }

    storage.getClientUptime(query, (resultData) => {
      res.json(toPublicUptime(resultData));
    });
  }
});

// get request for the list of all active nodes
app.get('/pool/stats', listNodesLimiter, (_req, res) => {
  res.json(nodeCache.getStats());
});

// set the interval for the uptime check of all nodes
setInterval(checkNodesUptimeStatus, config.uptime.period * 1000);
