// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const { resolveProbeTarget } = require('./probe.js');

const probeSkipMs = 15 * 60 * 1000;

const listingKey = (data) => {
  const { host, port } = resolveProbeTarget(data);

  return `${String(host).toLowerCase()}:${Number(port)}`;
};

const mustProbe = (existing, data, lastProbeAt, now = Date.now()) => {
  if (!existing) {
    return true;
  }

  if (listingKey(existing) !== listingKey(data)) {
    return true;
  }

  if (!lastProbeAt) {
    return true;
  }

  return now - new Date(lastProbeAt).getTime() > probeSkipMs;
};

const preserveProbedChain = (incoming, existing) => {
  // On probe skip / failed re-probe: keep the last daemon getinfo snapshot
  // (height, fee, status, version, counters). Do not replace it with the
  // sanitized submit subset, which omits blockchain.version and peers/hashrate.
  if (existing?.blockchain && typeof existing.blockchain === 'object') {
    incoming.blockchain = { ...existing.blockchain };
  } else if (!incoming.blockchain) {
    incoming.blockchain = {};
  }

  return incoming;
};

const occupantIdForKey = (rows, key, exceptId) => {
  for (const row of rows) {
    if (row && row.id !== exceptId && listingKey(row) === key) {
      return row.id;
    }
  }

  return undefined;
};

const applyListingUpdate = ({ data, existing, reachable, occupantId }) => {
  const isNew = !existing;
  const isMove = Boolean(existing && listingKey(existing) !== listingKey(data));

  if ((isNew || isMove) && !reachable) {
    return {
      ok: false,
      reason: isNew ? 'new-unreachable' : 'move-unreachable',
    };
  }

  if (!isNew && !isMove && !reachable) {
    return { ok: true, store: preserveProbedChain(data, existing) };
  }

  const result = { ok: true, store: data };

  if (reachable && occupantId && occupantId !== data.id) {
    result.evictId = occupantId;
  }

  return result;
};

const reachableMajorityHeight = (values) => {
  const counts = {};
  let majority = 0;
  let majorityCount = 0;

  for (const value of values) {
    if (value.status?.isReachable !== true) {
      continue;
    }

    const height = value.blockchain ? value.blockchain.height : 0;
    counts[height] = (counts[height] || 0) + 1;

    if (counts[height] > majorityCount) {
      majorityCount = counts[height];
      majority = height;
    }
  }

  return majority;
};

const syncedNodes = (values, isSyncedOnly) => {
  if (!isSyncedOnly) {
    return values;
  }

  const majority = reachableMajorityHeight(values);

  return values.filter((value) => {
    if (value.status?.isReachable !== true) {
      return false;
    }

    const height = value.blockchain ? value.blockchain.height : 0;

    return height >= majority - 2;
  });
};

module.exports = {
  applyListingUpdate,
  listingKey,
  mustProbe,
  occupantIdForKey,
  preserveProbedChain,
  probeSkipMs,
  reachableMajorityHeight,
  syncedNodes,
};
