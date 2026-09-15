// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const { createHash } = require('node:crypto');

const publicNodeId = (id) => createHash('sha256').update(String(id), 'utf8').digest('hex');

const toPublicNode = (node) => {
  if (!node || typeof node !== 'object') {
    return node;
  }

  return { ...node, id: publicNodeId(node.id) };
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
