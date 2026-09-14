// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const { isHostAllowed, isValidPort } = require('./validate.js');
const CCX = require('conceal-api');

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

// height difference between submitted and daemon data that is treated as normal drift
const heightTolerance = 2;

// apply the values reported by the node daemon over the data submitted to the pool
const applyDaemonInfo = (data, info, logger) => {
  if (!info || typeof info !== 'object') {
    return;
  }

  if (!data.blockchain || typeof data.blockchain !== 'object') {
    data.blockchain = {};
  }

  const daemonHeight = Number(info.height);

  if (Number.isFinite(daemonHeight) && daemonHeight > 0) {
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

  if (typeof info.fee_address === 'string') {
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
};

// probe the node daemon, verify the submitted data against its response and hand
// back the node data with reachability and daemon-reported values applied
const probeNode = (data, options, callback) => {
  const host = data.url ? data.url.host : data.nodeHost;
  const port = data.url ? data.url.port : data.nodePort;
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

  const CCXApiSSL = new CCX({
    daemonHost: `https://${host}`,
    daemonRpcPort: port,
    timeout: apiTimeout,
  });

  // check SSL connection first
  CCXApiSSL.info()
    .then((info) => {
      applyDaemonInfo(data, info, logger);
      finish(true, true);
    })
    .catch(() => {
      const CCXApi = new CCX({
        daemonHost: `http://${host}`,
        daemonRpcPort: port,
        timeout: apiTimeout,
      });

      // check unsecure connection
      CCXApi.info()
        .then((info) => {
          applyDaemonInfo(data, info, logger);
          finish(false, true);
        })
        .catch(() => {
          finish(false, false);
        });
    });
};

module.exports = { applyDaemonInfo, probeNode };
