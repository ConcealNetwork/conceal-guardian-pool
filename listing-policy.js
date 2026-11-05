// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const config = require('./config.json');
const { resolveProbeTarget } = require('./probe.js');
const probeSkipMs = (config.probe?.skipSeconds ?? 240) * 1000;

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

// chain verdicts for the anchor band (anchor height - 2 .. anchor height + 2,
// the upper edge widened by slackBlocks) and the trailing anchor ring: verified,
// grace (re-checked on the next probe tick), reject, or unchecked when no anchor
// is known. The ring maximum is the last published entry (see anchor-ring.js).
const chainVerdict = (value, anchorHeight, ring, slackBlocks = 0) => {
  if (!Number.isInteger(anchorHeight)) {
    return 'unchecked';
  }

  const slack = Number.isInteger(slackBlocks) && slackBlocks > 0 ? slackBlocks : 0;

  const chain = value.blockchain && typeof value.blockchain === 'object' ? value.blockchain : {};
  const height = Number(chain.height);

  if (!Number.isFinite(height)) {
    return 'reject';
  }

  if (height < anchorHeight - 2 || height > anchorHeight + 2 + slack) {
    return 'reject';
  }

  const entries = typeof ring?.entries === 'function' ? ring.entries() : [];

  if (entries.length === 0) {
    return 'unchecked';
  }

  const claimedHash = typeof chain.tipHash === 'string' ? chain.tipHash.toLowerCase() : null;
  const verified = entries.some((entry) => entry.height === height && entry.hash === claimedHash);

  if (verified) {
    return 'verified';
  }

  if (height > entries[entries.length - 1].height) {
    return 'grace';
  }

  return 'reject';
};

const noteSyncedGrace = (value, verdict) => {
  if (!value.status || typeof value.status !== 'object') {
    return;
  }

  if (verdict === 'grace') {
    value.status.syncedGrace = true;
    return;
  }

  delete value.status.syncedGrace;
};

const ringCoversHeight = (ring, height) => {
  const entries = typeof ring?.entries === 'function' ? ring.entries() : [];

  return entries.some((entry) => entry.height === height);
};

// a ring-covered hash miss removes the listing; other rejects leave it cached
const applyChainGate = (cache, record, anchorHeight, ring, slackBlocks = 0) => {
  const verdict = chainVerdict(record, anchorHeight, ring, slackBlocks);

  noteSyncedGrace(record, verdict);

  if (verdict !== 'reject') {
    return { ok: true, verdict };
  }

  const chain = record.blockchain && typeof record.blockchain === 'object' ? record.blockchain : {};
  const height = Number(chain.height);
  const covered = Number.isFinite(height) && ringCoversHeight(ring, height);

  if (covered && typeof record.id === 'string' && record.id !== '') {
    cache.del(record.id);
  }

  return { ok: !covered, verdict: 'reject' };
};

const syncedNodes = (values, isSyncedOnly, anchorHeight, ring, slackBlocks = 0) => {
  if (!isSyncedOnly) {
    return values;
  }

  if (!Number.isInteger(anchorHeight)) {
    return [];
  }

  return values.filter((value) => {
    if (value.status?.isReachable !== true) {
      return false;
    }

    const verdict = chainVerdict(value, anchorHeight, ring, slackBlocks);
    noteSyncedGrace(value, verdict);

    return verdict !== 'reject';
  });
};

module.exports = {
  applyChainGate,
  applyListingUpdate,
  chainVerdict,
  listingKey,
  mustProbe,
  occupantIdForKey,
  preserveProbedChain,
  probeSkipMs,
  syncedNodes,
};
