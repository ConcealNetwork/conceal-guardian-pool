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
const { anchorHoldMs, nextAnchor } = require('./seed-anchor.js');
const { sampleSeeds } = require('./seed-sample.js');
const { cacheMaxKeys, storeListing } = require('./listing-cache.js');
const {
  applyListingUpdate,
  listingKey,
  mustProbe,
  occupantIdForKey,
  preserveProbedChain,
  syncedNodes,
} = require('./listing-policy.js');
const { toPublicNode, toPublicUptime, resolvePrivateId } = require('./public-id.js');
const { publicGetCors, concealWriteCors } = require('./middleware-cors.js');
const { createOwnershipRegistry } = require('./ownership-registry.js');
const {
  createReplayGuard,
  identityAllowsNewListing,
  ownershipAllowsEviction,
  ownershipAllowsUpdate,
  verifySubmitAuth,
} = require('./submit-auth.js');
const crypto = require('node:crypto');
const path = require('node:path');

// query api timeout
const apiTimeout = 3000;

let seedAnchor = null;
let seedRefreshInFlight = false;
const seedAddressPins = new Map();

// Hold duration follows this clock. A wall-clock step must not expire the anchor.
const monotonicNowMs = () => Number(process.hrtime.bigint() / 1_000_000n);

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

const refreshSeedAnchor = () => {
  if (!Array.isArray(config.seeds) || config.seeds.length === 0) {
    logger.warn('No seeds configured; the default synced set will stay empty');
    return;
  }

  if (seedRefreshInFlight) {
    logger.warn('Seed anchor refresh still running');
    return;
  }

  seedRefreshInFlight = true;
  sampleSeeds(config.seeds, apiTimeout, seedAddressPins)
    .then(({ replies, rememberedHosts, lookupFailures, blockedHosts, droppedHosts }) => {
      if (lookupFailures.length > 0) {
        logger.warn('Seed lookup failed', { hosts: lookupFailures });
      }

      if (blockedHosts.length > 0) {
        logger.warn('Seed address blocked', { hosts: blockedHosts });
      }

      if (rememberedHosts.length > 0) {
        logger.warn('Seed name did not resolve; using the remembered address', {
          hosts: rememberedHosts,
        });
      }

      if (droppedHosts.length > 0) {
        logger.warn('Seed dropped because the address and port were already sampled', {
          hosts: droppedHosts,
        });
      }

      const previous = seedAnchor;

      seedAnchor = nextAnchor(previous, replies, Date.now(), anchorHoldMs, monotonicNowMs());

      if (
        seedAnchor &&
        (!previous || previous.height !== seedAnchor.height || previous.hash !== seedAnchor.hash)
      ) {
        logger.info('Published seed anchor', {
          height: seedAnchor.height,
          hash: seedAnchor.hash,
        });
      } else if (!seedAnchor && previous) {
        logger.warn('Seed anchor expired');
      }
    })
    .catch((error) => {
      logger.error('Seed anchor refresh failed', { message: error.message });
    })
    .finally(() => {
      seedRefreshInFlight = false;
    });
};

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

// proof-of-ownership policy for /pool/update: ed25519 submissions are preferred,
// unsigned ones stay accepted until requireSigned flips the hard cutover
const updateAuthConfig = config.updateAuth || {};
const requireSignedSubmissions = updateAuthConfig.requireSigned === true;
const authMaxSkewMs = (updateAuthConfig.maxSkewSeconds ?? 300) * 1000;
const maxListingsPerKey = updateAuthConfig.maxListingsPerKey ?? 8;
const anonymousListingCap = updateAuthConfig.anonymousListingCap ?? 450;

// RAM-only registry binding verified node ids to their ed25519 public key.
// Never persisted to the database: a restart forgets ownership until owners
// re-submit a signed update. Claims are reserved synchronously before any
// async probe work (no registration takeover race) and reconciled against the
// listing cache so expiries and evictions release them again.
const registry = createOwnershipRegistry();

// Signed submissions must not be replayable within the skew window: the first
// presentation of a signature wins, later ones are refused for twice the skew
// span (the widest period one signature stays valid). RAM-only, so a restart
// lapse remains a disclosed residual.
const submitReplayGuard = createReplayGuard({ ttlMs: authMaxSkewMs * 2 });

const nodeCache = new NodeCache({
  stdTTL: config.cache.expire,
  checkperiod: config.cache.checkPeriod,
  maxKeys: cacheMaxKeys,
});
const storage = new database(); // create a new storage instance
const app = express(); // create express app
app.disable('x-powered-by');

// cache for last uptime check
const updateCache = {};

// attach other libraries to the express application
app.set('trust proxy', 1); // trust first proxy
app.use(express.json({ limit: '16kb' })); // Express v5 built-in body parser

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

// unsigned listings occupy a bounded budget of the cache so verified identities
// can always find a slot (SG-010 starvation guard)
function countAnonymousListings() {
  return getAllNodes(nodeCache.keys()).filter((row) => !registry.claims.has(row.id)).length;
}

// Least-recently-updated anonymous listing: the slot a verified submission may
// take when the cache is at its hard cap. Claimed and in-flight ids are never
// victims. Records always carry status.lastSeen (set before commit); a missing
// or unparseable stamp sorts oldest so the slot stays reclaimable.
function oldestAnonymousListingId() {
  let victim;
  let oldestSeen = Number.POSITIVE_INFINITY;

  for (const key of nodeCache.keys()) {
    const row = nodeCache.get(key);

    if (!row || registry.claims.has(row.id) || registry.pending.has(row.id)) {
      continue;
    }

    const seen = Date.parse(row.status?.lastSeen);
    const stamp = Number.isFinite(seen) ? seen : 0;

    if (stamp < oldestSeen) {
      oldestSeen = stamp;
      victim = row.id;
    }
  }

  return victim;
}

// Release registry claims whose listing expired or was evicted (HIGH: the
// registry would otherwise grow unboundedly and pollute every bound counted
// over it). In-flight registrations are protected by the pending grace period.
function reconcileRegistry() {
  registry.reconcile(new Set(nodeCache.keys()));
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

  return syncedNodes(
    filteredValues,
    isSyncedOnly,
    seedAnchor && Number.isInteger(seedAnchor.height) ? seedAnchor.height : null
  );
}

function setNodeData(data, auth, callback) {
  const verified = auth?.verified === true;
  const publicKey = auth?.publicKey;

  // Expiries and evictions must release claims before any bound is counted
  // over the registry, otherwise stale entries pollute every registry bound.
  registry.reconcile(new Set(nodeCache.keys()));

  if (!ownershipAllowsUpdate({ registry: registry.claims, id: data.id, verified, publicKey })) {
    logger.warn(`Rejected node ${data.id} update without proof of ownership`);
    callback(false);
    return;
  }

  // Admission is decided synchronously. The verified bound is enforced for
  // every signed submission, including moves of an already-held listing, so
  // the per-identity cap cannot be bypassed by re-homing an id; the anonymous
  // budget only ever gates genuinely new ids.
  if (
    verified &&
    !identityAllowsNewListing({
      registry: registry.claims,
      id: data.id,
      publicKey,
      maxListingsPerKey,
      registryCap: cacheMaxKeys,
    })
  ) {
    logger.warn(`Rejected node ${data.id} listing over the per-identity or registry bound`);
    callback(false);
    return;
  }

  if (!verified && !nodeCache.has(data.id) && countAnonymousListings() >= anonymousListingCap) {
    logger.warn('Rejected a new unsigned listing because the anonymous listing budget is full');
    callback(false);
    return;
  }

  // Reserve the ownership claim synchronously, before any async storage or
  // probe work: the check-and-set never awaits, so two concurrent signed
  // submissions for the same unclaimed id cannot both enter the flow — the
  // second is refused by ownershipAllowsUpdate while the first is in flight.
  const reservedHere = verified === true && !registry.claims.has(data.id);

  if (reservedHere) {
    registry.claimForUpdate(data.id, publicKey);
  }

  // Every outcome routes through finish: a landed verified listing confirms
  // the reservation, any failure rolls it back so a rejected registration
  // cannot squat the id or count against the bounds.
  const finish = (ok) => {
    if (verified && ok === true) {
      registry.confirm(data.id, publicKey);
    } else if (reservedHere) {
      registry.release(data.id, publicKey);
    }

    callback(ok);
  };

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
          finish(false);
          return;
        }

        if (
          result.evictId &&
          !ownershipAllowsEviction({
            registry: registry.claims,
            occupantId: result.evictId,
            verified,
            publicKey,
          })
        ) {
          logger.warn(`Rejected node ${record.id} eviction of the owned node ${result.evictId}`);
          finish(false);
          return;
        }

        if (result.evictId) {
          nodeCache.del(result.evictId);
        }

        const stored = storeListing(
          nodeCache,
          result.store.id,
          result.store,
          config.cache.expire,
          cacheMaxKeys,
          logger,
          verified ? oldestAnonymousListingId : undefined
        );

        finish(stored);
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
app.get('/pool/list', publicGetCors, listNodesLimiter, (req, res) => {
  res.json({
    success: true,
    list: filterResults(req, getAllNodes(nodeCache.keys())).map(toPublicNode),
  });
});

// count all active nodes by specified filters
app.get('/pool/count', publicGetCors, listNodesLimiter, (req, res) => {
  res.json({ success: true, count: filterResults(req, getAllNodes(nodeCache.keys())).length });
});

// get the random node back to user
app.get('/pool/random', publicGetCors, listNodesLimiter, (req, res) => {
  const nodeList = filterResults(req, getAllNodes(nodeCache.keys()));
  const randomNode = nodeList.length ? nodeList[crypto.randomInt(nodeList.length)] : undefined;

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

// post request for updating the node data (Joe's node has no Origin — CORS skipped)
app.options('/pool/update', concealWriteCors);
app.post('/pool/update', concealWriteCors, updateNodeLimiter, (req, res) => {
  const auth = verifySubmitAuth(req.body, { maxSkewMs: authMaxSkewMs });

  if (!auth.verified) {
    if (auth.reason !== 'missing') {
      logger.warn('Rejected an update request with invalid submission authentication', {
        reason: auth.reason,
      });
      res.json({ success: false });
      return;
    }

    if (requireSignedSubmissions) {
      logger.warn('Rejected an unsigned update request because signed submissions are required');
      res.json({ success: false });
      return;
    }
  }

  if (auth.verified) {
    const signature =
      typeof req.body?.auth?.signature === 'string' ? req.body.auth.signature.toLowerCase() : '';

    if (!signature || !submitReplayGuard.checkAndRecord(signature)) {
      logger.warn('Rejected a replayed signed update submission');
      res.json({ success: false });
      return;
    }
  }

  const record = sanitizeNodeUpdate(req.body, logger);

  if (record) {
    setNodeData(record, auth.verified ? auth : null, (result) => {
      res.json({ success: result });
    });
  } else {
    logger.warn('Rejected an update request with an invalid payload');
    res.json({ success: false });
  }
});

// post request for updating the node data
app.options('/pool/uptime', concealWriteCors);
app.all(
  '/pool/uptime',
  (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return publicGetCors(req, res, next);
    return concealWriteCors(req, res, next);
  },
  listNodesLimiter,
  (req, res) => {
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
  }
);

// get request for the list of all active nodes
app.get('/pool/stats', publicGetCors, listNodesLimiter, (_req, res) => {
  res.json(nodeCache.getStats());
});

// release registry claims whose listing expired or was evicted, even with
// zero update traffic, so the registry stays bounded by the live cache
setInterval(reconcileRegistry, config.cache.checkPeriod * 1000);

// set the interval for the uptime check of all nodes
setInterval(checkNodesUptimeStatus, config.uptime.period * 1000);
refreshSeedAnchor();
setInterval(refreshSeedAnchor, config.uptime.period * 1000);
