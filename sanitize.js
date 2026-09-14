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

    if (typeof value === 'string') {
      result[key.substring(0, 50)] = value.substring(0, maxValueLength);
      count++;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      result[key.substring(0, 50)] = value;
      count++;
    } else if (typeof value === 'boolean') {
      result[key.substring(0, 50)] = value;
      count++;
    }
  }

  return result;
};

// build a validated node record from the submitted update payload, null when rejected
const sanitizeNodeUpdate = (body, logger, nowMs = Date.now()) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const id = typeof body.id === 'string' ? body.id : '';
  const nodeHost = typeof body.nodeHost === 'string' ? body.nodeHost : '';

  if (!isValidNodeId(id)) {
    return null;
  }

  if (!isHostAllowed(nodeHost)) {
    return null;
  }

  if (!isValidPort(body.nodePort)) {
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

  // optional custom url, dropped when it does not pass validation
  if (body.url && typeof body.url === 'object' && !Array.isArray(body.url)) {
    if (
      isHostAllowed(body.url.host) &&
      (isOmittedPort(body.url.port) || isValidPort(body.url.port))
    ) {
      record.url = {
        host: body.url.host,
        port: isValidPort(body.url.port) ? Number(body.url.port) : '',
      };
    } else {
      logger.warn(`Node ${id} submitted an invalid custom url, ignoring it`);
    }
  }

  if (body.status && typeof body.status === 'object' && !Array.isArray(body.status)) {
    const errors = Number(body.status.errors);

    record.status = {
      errors: Number.isFinite(errors) ? errors : 0,
      startTime: sanitizedString(body.status.startTime, 50) || '',
      initialized: body.status.initialized === true,
    };
  }

  if (body.blockchain && typeof body.blockchain === 'object' && !Array.isArray(body.blockchain)) {
    const blockchain = {};

    // reject the update when present fields have a wrong type or an out-of-range value
    if (body.blockchain.height !== undefined) {
      const height = Number(body.blockchain.height);

      if (!isSubmittedHeightAccepted(height, nowMs)) {
        const maxAccepted = expectedHeight(nowMs) + heightWeekBlocks;

        logger.warn(`Rejected node ${id} height ${height} (max accepted ${maxAccepted})`);
        return null;
      }

      blockchain.height = height;
    }

    if (body.blockchain.fee_address !== undefined) {
      if (!isValidFeeAddress(body.blockchain.fee_address)) {
        return null;
      }

      blockchain.fee_address = body.blockchain.fee_address;
    }

    if (body.blockchain.status !== undefined) {
      const status = sanitizedString(body.blockchain.status, 100);

      if (status === null) {
        return null;
      }

      blockchain.status = status;
    }

    record.blockchain = blockchain;
  }

  if (body.location && typeof body.location === 'object' && !Array.isArray(body.location)) {
    const location = {};
    const ip = sanitizedString(body.location.ip, 64);

    if (ip !== null) {
      location.ip = ip;
    }

    if (
      body.location.data &&
      typeof body.location.data === 'object' &&
      !Array.isArray(body.location.data)
    ) {
      location.data = sanitizedPrimitiveMap(body.location.data, 20, 200);
    }

    record.location = location;
  }

  return record;
};

module.exports = { sanitizeNodeUpdate, sanitizedPrimitiveMap, sanitizedString };
