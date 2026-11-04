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

  // internal admission fields never appear in the API response; the response
  // shape stays exactly what it was before they were stored on the record
  if ('admissionTier' in publicNode) {
    delete publicNode.admissionTier;
  }

  if ('submitterIp' in publicNode) {
    delete publicNode.submitterIp;
  }

  if (
    publicNode.status &&
    typeof publicNode.status === 'object' &&
    'syncedGrace' in publicNode.status
  ) {
    const status = { ...publicNode.status };

    delete status.syncedGrace;
    publicNode.status = status;
  }

  if (
    publicNode.blockchain &&
    typeof publicNode.blockchain === 'object' &&
    'tipHash' in publicNode.blockchain
  ) {
    const blockchain = { ...publicNode.blockchain };

    delete blockchain.tipHash;
    publicNode.blockchain = blockchain;
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
