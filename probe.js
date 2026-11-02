// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');

const {
  isAddressBlocked,
  isHostAllowed,
  isSubmittedHeightAccepted,
  isValidFeeAddress,
  isValidPort,
} = require('./validate.js');

const resolveProbeTarget = (data) => {
  const hasDomainUrl = Boolean(data.url?.host);
  const host = hasDomainUrl ? data.url.host : data.nodeHost;
  const explicitPort = hasDomainUrl ? data.url.port : data.nodePort;

  if (isValidPort(explicitPort)) {
    return { host, port: Number(explicitPort) };
  }

  return { host, port: hasDomainUrl ? 443 : data.nodePort };
};

// daemon-reported fields that are copied over the submitted node data
const daemonNumericFields = [
  'difficulty',
  'grey_peerlist_size',
  'hashrate',
  'incoming_connections_count',
  'outgoing_connections_count',
  'transactions_pool_size',
  'white_peerlist_size',
];

// height difference that is logged; an in-window daemon height is still kept
const heightTolerance = 2;

// apply the values reported by the node daemon over the data submitted to the pool.
// returns false when the daemon response is rejected as a whole; nothing is copied
// from a rejected response
const applyDaemonInfo = (data, info, logger, nowMs = Date.now()) => {
  if (!info || typeof info !== 'object') {
    return true;
  }

  if (!data.blockchain || typeof data.blockchain !== 'object') {
    data.blockchain = {};
  }

  const daemonHeight = Number(info.height);

  if (Number.isFinite(daemonHeight) && daemonHeight > 0) {
    // a daemon height outside the accepted window is a fabricated tip
    if (!isSubmittedHeightAccepted(daemonHeight, nowMs)) {
      logger.warn(
        `Node ${data.id} daemon reports height ${daemonHeight} outside the accepted window, rejecting the daemon response`
      );
      return false;
    }

    const claimedHeight = Number(data.blockchain.height);

    if (
      Number.isFinite(claimedHeight) &&
      Math.abs(claimedHeight - daemonHeight) > heightTolerance
    ) {
      logger.warn(
        `Node ${data.id} submitted height ${claimedHeight} but the daemon reports ${daemonHeight}, keeping the daemon value`
      );
    }

    data.blockchain.height = daemonHeight;
  }

  if (isValidFeeAddress(info.fee_address)) {
    if ((data.blockchain.fee_address || '') !== info.fee_address) {
      logger.warn(
        `Node ${data.id} submitted a fee_address that does not match the daemon response, keeping the daemon value`
      );
    }

    data.blockchain.fee_address = info.fee_address;
  }

  if (typeof info.status === 'string') {
    data.blockchain.status = info.status;
  }

  if (typeof info.version === 'string') {
    data.blockchain.version = info.version;
  }

  daemonNumericFields.forEach((field) => {
    const value = Number(info[field]);

    if (Number.isFinite(value)) {
      data.blockchain[field] = value;
    }
  });

  return true;
};

// resolve the probe hostname once and pin every address it maps to; the whole
// set is rejected when any resolved address is blocked (all-or-nothing)
const resolvePinnedAddresses = (hostname) =>
  new Promise((resolve) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error || !Array.isArray(addresses) || addresses.length === 0) {
        resolve(null);
        return;
      }

      if (addresses.some((entry) => isAddressBlocked(entry.address))) {
        resolve(null);
        return;
      }

      resolve(addresses.map((entry) => entry.address));
    });
  });

// one GET {path}/getinfo against a single pinned address; resolves null on any
// failure. SNI and certificate identity stay bound to the hostname while the
// connection itself uses the pinned address.
const fetchDaemonInfo = (hostname, address, port, pathPrefix, useSSL, apiTimeout) =>
  new Promise((resolve) => {
    const path = `/${[pathPrefix, 'getinfo'].filter(Boolean).join('/')}`;
    const requestOptions = {
      host: address,
      port,
      path,
      method: 'GET',
      timeout: apiTimeout,
      headers: { accept: 'application/json', host: `${hostname}:${port}` },
    };

    if (useSSL) {
      requestOptions.servername = hostname;
    }

    const request = (useSSL ? https : http).request(requestOptions, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }

      let body = '';
      let settled = false;
      const finish = (info) => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(info);
      };

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;

        if (body.length > 65536) {
          request.destroy();
          finish(null);
        }
      });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const info = parsed && typeof parsed === 'object' ? (parsed.result ?? parsed) : null;

          finish(info && typeof info === 'object' ? info : null);
        } catch {
          finish(null);
        }
      });
    });

    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
    request.end();
  });

// probe the node daemon, verify the submitted data against its response and hand
// back the node data with reachability and daemon-reported values applied
const probeNode = (data, options, callback) => {
  const { host, port } = resolveProbeTarget(data);
  const logger = options.logger;
  const apiTimeout = options.apiTimeout;

  const finish = (hasSSL, isReachable) => {
    data.status.hasSSL = hasSSL;
    data.status.isReachable = isReachable;
    callback(data);
  };

  // only probe host:port targets that pass validation
  if (!isHostAllowed(host) || !isValidPort(port)) {
    logger.warn(`Skipping the probe for node ${data.id} because of an invalid host or port`);
    finish(false, false);
    return;
  }

  const slash = host.indexOf('/');
  const hostname = slash === -1 ? host : host.slice(0, slash);
  const pathPrefix = slash === -1 ? '' : host.slice(slash + 1);
  const normalized = hostname.replace(/^\[|]$/g, '');

  resolvePinnedAddresses(normalized).then((pinned) => {
    if (!pinned) {
      logger.warn(
        `Skipping the probe for node ${data.id} because its resolved addresses were rejected`
      );
      finish(false, false);
      return;
    }

    const attemptAll = (useSSL, index) => {
      if (index >= pinned.length) {
        return Promise.resolve(null);
      }

      return fetchDaemonInfo(normalized, pinned[index], port, pathPrefix, useSSL, apiTimeout).then(
        (info) => info || attemptAll(useSSL, index + 1)
      );
    };

    attemptAll(true, 0).then((sslInfo) => {
      if (sslInfo) {
        const accepted = applyDaemonInfo(data, sslInfo, logger, Date.now());
        finish(accepted, accepted);
        return;
      }

      // re-validate the pinned set before the plain-HTTP fallback
      if (pinned.some((address) => isAddressBlocked(address))) {
        finish(false, false);
        return;
      }

      attemptAll(false, 0).then((info) => {
        if (!info) {
          finish(false, false);
          return;
        }

        const accepted = applyDaemonInfo(data, info, logger, Date.now());
        finish(false, accepted);
      });
    });
  });
};

module.exports = { applyDaemonInfo, probeNode, resolveProbeTarget };
