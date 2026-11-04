// Copyright (c) 2019 -2026, Acktarius, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const cacheMaxKeys = 500;
const evictionBatchRatio = 0.05;

const lastSeenMs = (record) => {
  const seen = Date.parse(record?.status?.lastSeen);

  return Number.isFinite(seen) ? seen : 0;
};

// Evict the least recently seen listings in a small batch, so a stale entry
// cannot block an actively reporting newcomer from being stored.
const evictLeastRecentlySeen = (cache, keepId, batch) => {
  const rows = [];

  for (const key of cache.keys()) {
    if (key === keepId) {
      continue;
    }

    rows.push({ key, seen: lastSeenMs(cache.get(key)) });
  }

  rows.sort((left, right) => left.seen - right.seen);

  const evicted = Math.min(batch, rows.length);

  for (let index = 0; index < evicted; index++) {
    cache.del(rows[index].key);
  }

  return evicted;
};

// node-cache rejects set() once the key count is at the cap, including a refresh
// of a key that is already stored. Drop that slot first so the refresh can land.
// A new listing evicts the least recently seen entries instead of being refused.
const storeListing = (cache, id, record, ttl, maxKeys, logger) => {
  if (cache.getStats().keys >= maxKeys && cache.has(id)) {
    cache.del(id);
  }

  try {
    return cache.set(id, record, ttl);
  } catch (error) {
    if (error?.errorcode !== 'ECACHEFULL') {
      throw error;
    }

    const batch = Math.max(1, Math.round(maxKeys * evictionBatchRatio));

    if (evictLeastRecentlySeen(cache, id, batch) === 0) {
      logger.warn('Rejected a listing because the node cache is full', { nodeId: id });
      return false;
    }

    try {
      return cache.set(id, record, ttl);
    } catch (retryError) {
      if (retryError?.errorcode === 'ECACHEFULL') {
        logger.warn('Rejected a listing because the node cache is full', { nodeId: id });
        return false;
      }

      throw retryError;
    }
  }
};

module.exports = { cacheMaxKeys, storeListing };
