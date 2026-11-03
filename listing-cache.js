// Copyright (c) 2019 -2026, Acktarius, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const cacheMaxKeys = 500;

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

module.exports = { cacheMaxKeys, storeListing };
