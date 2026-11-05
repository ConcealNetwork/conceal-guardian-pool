// Copyright (c) 2019 -2026, Acktarius, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const config = require('./config.json');

// code default when cache.maxKeys is missing or not an integer >= 1
const defaultMaxKeys = 30;

const resolveCacheMaxKeys = (value) => {
  const parsed = Math.floor(Number(value));

  return Number.isInteger(parsed) && parsed >= 1 ? parsed : defaultMaxKeys;
};

const cacheMaxKeys = resolveCacheMaxKeys(config.cache?.maxKeys);

// node-cache rejects set() once the key count is at the cap, including a refresh
// of a key that is already stored. Drop that slot first so the refresh can land.
const storeListing = (cache, id, record, ttl, maxKeys, logger) => {
  if (cache.getStats().keys >= maxKeys && cache.has(id)) {
    cache.del(id);
  }

  try {
    return cache.set(id, record, ttl);
  } catch (error) {
    if (error?.errorcode === 'ECACHEFULL') {
      logger.warn('Rejected a listing because the node cache is full', { nodeId: id });
      return false;
    }

    throw error;
  }
};

module.exports = { cacheMaxKeys, resolveCacheMaxKeys, storeListing };
