// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const {
  expectedHeight,
  heightWeekBlocks,
  isHostAllowed,
  isOmittedPort,
  isSubmittedHeightAccepted,
  isValidFeeAddress,
  isValidNodeId,
  isValidPort,
} = require('./validate.js');

const sanitizedString = (value, maxLength) => {
  if (typeof value !== 'string') {
    return null;
  }

  return value.substring(0, maxLength);
};

const sanitizedPrimitiveMap = (source, maxEntries, maxValueLength) => {
  const result = {};
  let count = 0;

  for (const key of Object.keys(source)) {
    if (count >= maxEntries) {
      break;
    }

    const value = source[key];
    const shortKey = key.substring(0, 50);

    if (typeof value === 'string') {
      result[shortKey] = value.substring(0, maxValueLength);
      count++;
    } else if (
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'boolean'
    ) {
      result[shortKey] = value;
      count++;
    }
  }

  return result;
};

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const applyCustomUrl = (record, url, logger) => {
  if (!isPlainObject(url)) {
    return;
  }

  if (isHostAllowed(url.host) && (isOmittedPort(url.port) || isValidPort(url.port))) {
    record.url = {
      host: url.host,
      port: isValidPort(url.port) ? Number(url.port) : '',
    };
    return;
  }

  logger.warn(`Node ${record.id} submitted an invalid custom url, ignoring it`);
};

const applyStatus = (record, status) => {
  if (!isPlainObject(status)) {
    return;
  }

  const errors = Number(status.errors);

  record.status = {
    errors: Number.isFinite(errors) ? errors : 0,
    startTime: sanitizedString(status.startTime, 50) || '',
    initialized: status.initialized === true,
  };
};

/** @returns {boolean} false when the update must be rejected */
const applyBlockchain = (record, blockchain, logger, nowMs) => {
  if (!isPlainObject(blockchain)) {
    return true;
  }

  const out = {};

  if (blockchain.height !== undefined) {
    const height = Number(blockchain.height);

    if (!isSubmittedHeightAccepted(height, nowMs)) {
      const maxAccepted = expectedHeight(nowMs) + heightWeekBlocks;
      logger.warn(`Rejected node ${record.id} height ${height} (max accepted ${maxAccepted})`);
      return false;
    }

    out.height = height;
  }

  if (blockchain.fee_address !== undefined) {
    if (!isValidFeeAddress(blockchain.fee_address)) {
      return false;
    }

    out.fee_address = blockchain.fee_address;
  }

  if (blockchain.status !== undefined) {
    const status = sanitizedString(blockchain.status, 100);

    if (status === null) {
      return false;
    }

    out.status = status;
  }

  record.blockchain = out;
  return true;
};

const applyLocation = (record, location) => {
  if (!isPlainObject(location)) {
    return;
  }

  const out = {};
  const ip = sanitizedString(location.ip, 64);

  if (ip !== null) {
    out.ip = ip;
  }

  if (isPlainObject(location.data)) {
    out.data = sanitizedPrimitiveMap(location.data, 20, 200);
  }

  record.location = out;
};

// build a validated node record from the submitted update payload, null when rejected
const sanitizeNodeUpdate = (body, logger, nowMs = Date.now()) => {
  if (!isPlainObject(body)) {
    return null;
  }

  const id = typeof body.id === 'string' ? body.id : '';
  const nodeHost = typeof body.nodeHost === 'string' ? body.nodeHost : '';

  if (!isValidNodeId(id) || !isHostAllowed(nodeHost) || !isValidPort(body.nodePort)) {
    return null;
  }

  const record = {
    id: id,
    os: sanitizedString(body.os, 50) || '',
    name: sanitizedString(body.name, 200) || '',
    version: sanitizedString(body.version, 50) || '',
    nodeHost: nodeHost,
    nodePort: Number(body.nodePort),
    status: {},
    blockchain: null,
    location: null,
  };

  applyCustomUrl(record, body.url, logger);
  applyStatus(record, body.status);

  if (!applyBlockchain(record, body.blockchain, logger, nowMs)) {
    return null;
  }

  applyLocation(record, body.location);

  return record;
};

module.exports = { sanitizeNodeUpdate, sanitizedPrimitiveMap, sanitizedString };
