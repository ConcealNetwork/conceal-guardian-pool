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

const syncedNodes = (values, isSyncedOnly, anchorHeight) => {
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

    const height = value.blockchain ? value.blockchain.height : 0;

    return height >= anchorHeight - 2;
  });
};

// Sybil selection weighting. The synced set is anchored on seed agreement, so
// fake daemons at the real tip still enter the listing. The random pick gives
// a concentrated block of fresh nodes only a bounded share instead of its raw
// node count.
const defaultPrefixCap = 5;
const tenureStepMs = 10 * 60 * 1000;
const maxTenureSteps = 5;

const ipv4Prefix = (host) => {
  if (typeof host !== 'string') {
    return null;
  }

  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(host);

  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
};

// Weight 1 for a node first seen recently, +1 per full 10 minutes of
// continuous presence in the pool, capped at 6. Records without firstSeen are
// treated as brand new.
const tenureWeight = (node, nowMs = Date.now()) => {
  const seen = Date.parse(node?.status?.firstSeen);

  if (!Number.isFinite(seen)) {
    return 1;
  }

  return 1 + Math.min(Math.floor(Math.max(0, nowMs - seen) / tenureStepMs), maxTenureSteps);
};

// A dotted-quad host groups by its /24. Anything else (a domain or IPv6
// literal) groups by itself, so nodes without a comparable prefix keep their
// uncapped individual weight.
const prefixGroup = (node) =>
  ipv4Prefix(node.nodeHost) ?? `host:${String(node.nodeHost).toLowerCase()}`;

// Per-node effective weight: what the node adds to its prefix before the
// prefix total reaches the cap. The first nodes seen in a prefix claim the
// budget; further nodes in the same /24 add nothing.
const selectionWeights = (nodes, prefixCap = defaultPrefixCap, nowMs = Date.now()) => {
  const weights = [];
  const prefixTotals = new Map();

  for (const node of nodes) {
    const group = prefixGroup(node);
    const total = prefixTotals.get(group) ?? 0;
    const capped = Math.min(total + tenureWeight(node, nowMs), prefixCap);

    weights.push(capped - total);
    prefixTotals.set(group, capped);
  }

  return weights;
};

// Weighted random pick over an already-filtered node list. Returns undefined
// for an empty list and the only node for a single-entry list.
const pickWeightedNode = (nodes, options = {}) => {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return undefined;
  }

  if (nodes.length === 1) {
    return nodes[0];
  }

  const { prefixCap = defaultPrefixCap, nowMs = Date.now(), random = Math.random } = options;
  const weights = selectionWeights(nodes, prefixCap, nowMs);
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  if (total <= 0) {
    return nodes[Math.floor(random() * nodes.length) % nodes.length];
  }

  let threshold = random() * total;

  for (let index = 0; index < nodes.length; index++) {
    threshold -= weights[index];

    if (threshold < 0) {
      return nodes[index];
    }
  }

  return nodes[nodes.length - 1];
};

module.exports = {
  applyListingUpdate,
  defaultPrefixCap,
  ipv4Prefix,
  listingKey,
  mustProbe,
  occupantIdForKey,
  pickWeightedNode,
  preserveProbedChain,
  probeSkipMs,
  selectionWeights,
  syncedNodes,
  tenureWeight,
};
