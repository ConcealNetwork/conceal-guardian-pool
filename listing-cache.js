// Copyright (c) 2019 -2026, Acktarius, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const cacheMaxKeys = 500;

// node-cache rejects set() once the key count is at the cap, including a refresh
// of a key that is already stored. Drop that slot first so the refresh can land.
// For a verified submission (evictOldestAnonymous supplied), a full cache must
// not refuse the listing while anonymous listings still occupy slots: free the
// least-recently-updated anonymous slot the caller selects and retry once, so
// the verified exemption from the anonymous admission budget is real at the
// hard cap too. Without the callback the pre-existing refusal applies.
const storeListing = (cache, id, record, ttl, maxKeys, logger, evictOldestAnonymous) => {
  if (cache.getStats().keys >= maxKeys && cache.has(id)) {
    cache.del(id);
  }

  try {
    return cache.set(id, record, ttl);
  } catch (error) {
    if (error?.errorcode !== 'ECACHEFULL') {
      throw error;
    }

    if (typeof evictOldestAnonymous !== 'function') {
      logger.warn('Rejected a listing because the node cache is full', { nodeId: id });
      return false;
    }

    const victimId = evictOldestAnonymous();

    if (!victimId || victimId === id) {
      logger.warn('Rejected a verified listing because no anonymous slot was freeable', {
        nodeId: id,
      });
      return false;
    }

    cache.del(victimId);

    try {
      return cache.set(id, record, ttl);
    } catch (retryError) {
      if (retryError?.errorcode !== 'ECACHEFULL') {
        throw retryError;
      }

      logger.warn('Rejected a verified listing because the node cache stayed full', {
        nodeId: id,
      });
      return false;
    }
  }
};

module.exports = { cacheMaxKeys, storeListing };
