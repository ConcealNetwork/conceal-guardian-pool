// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const { createHash } = require('node:crypto');

const publicNodeId = (id) => createHash('sha256').update(String(id), 'utf8').digest('hex');

const toPublicNode = (node) => {
  if (!node || typeof node !== 'object') {
    return node;
  }

  const publicNode = { ...node, id: publicNodeId(node.id) };

  // firstSeen drives in-process Sybil weighting and cache eviction only; it is
  // not part of the public API shape. Copy status before trimming so the
  // cached record is never mutated through the public projection.
  if (
    publicNode.status &&
    typeof publicNode.status === 'object' &&
    'firstSeen' in publicNode.status
  ) {
    publicNode.status = { ...publicNode.status };
    delete publicNode.status.firstSeen;
  }

  return publicNode;
};

const toPublicUptime = (resultData) => {
  if (!resultData || !Array.isArray(resultData.uptimes)) {
    return resultData;
  }

  return {
    ...resultData,
    uptimes: resultData.uptimes.map((row) => ({
      ...row,
      id: publicNodeId(row.id),
    })),
  };
};

const resolvePrivateId = (value, knownIds) => {
  if (typeof value !== 'string' || !Array.isArray(knownIds)) {
    return null;
  }

  if (knownIds.includes(value)) {
    return value;
  }

  const normalized = value.toLowerCase();

  for (const raw of knownIds) {
    if (publicNodeId(raw) === normalized) {
      return raw;
    }
  }

  return null;
};

module.exports = { publicNodeId, toPublicNode, toPublicUptime, resolvePrivateId };
