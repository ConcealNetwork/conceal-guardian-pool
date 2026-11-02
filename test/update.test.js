const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');

const {
  blockTimeSeconds,
  expectedHeight,
  heightAnchor,
  heightAnchorMs,
  heightWeekBlocks,
  isAddressBlocked,
  isHostAllowed,
  isSubmittedHeightAccepted,
  isValidFeeAddress,
  isValidNodeId,
  isValidPort,
} = require('../validate');
const { sanitizeNodeUpdate } = require('../sanitize');
const { applyDaemonInfo, probeNode, resolveProbeTarget } = require('../probe');

const nullLogger = { warn: () => {}, error: () => {}, info: () => {} };
const guardianId = '550e8400-e29b-41d4-a716-446655440000';
const publicIdHex = '9b3c7262aa2910984479a858acfeba56c45526faa6a994423afe1cce69b603bf';
const sampleFeeAddress = `ccx7${'x'.repeat(94)}`;

function validBody(overrides) {
  return Object.assign(
    {
      id: guardianId,
      os: 'linux',
      name: 'node-1',
      version: '6.0.0',
      nodeHost: '203.0.113.10',
      nodePort: 16000,
      status: { errors: 0, startTime: '2026-01-01T00:00:00Z', initialized: true },
      blockchain: { height: heightAnchor, fee_address: sampleFeeAddress, status: 'OK' },
      location: { ip: '203.0.113.10', data: { country: 'NL' } },
    },
    overrides
  );
}

describe('validate', () => {
  it('accepts guardian uuid v4 ids and rejects other id shapes', () => {
    assert.equal(isValidNodeId(guardianId), true);
    assert.equal(isValidNodeId(guardianId.toUpperCase()), true);
    assert.equal(isValidNodeId('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), false);
    assert.equal(isValidNodeId('node_A-1'), false);
    assert.equal(isValidNodeId(publicIdHex), false);
    assert.equal(isValidNodeId(''), false);
    assert.equal(isValidNodeId('bad id!'), false);
    assert.equal(isValidNodeId(42), false);
  });

  it('accepts valid hosts and rejects loopback, private, link-local and malformed ones', () => {
    assert.equal(isHostAllowed('203.0.113.10'), true);
    assert.equal(isHostAllowed('node1.example.com'), true);
    assert.equal(isHostAllowed('ccxapi.conceal.network'), true);
    assert.equal(isHostAllowed('ccxapi.conceal.network/daemon'), true);
    assert.equal(isHostAllowed('2001:db8::1'), true);
    assert.equal(isHostAllowed('127.0.0.1'), false);
    assert.equal(isHostAllowed('localhost'), false);
    assert.equal(isHostAllowed('10.0.0.1'), false);
    assert.equal(isHostAllowed('10.0.0.50'), false);
    assert.equal(isHostAllowed('192.168.1.1'), false);
    assert.equal(isHostAllowed('172.16.0.1'), false);
    assert.equal(isHostAllowed('172.31.255.1'), false);
    assert.equal(isHostAllowed('172.32.0.1'), true);
    assert.equal(isHostAllowed('169.254.1.1'), false);
    assert.equal(isHostAllowed('::1'), false);
    assert.equal(isHostAllowed('https://ccxapi.conceal.network/getinfo'), false);
    assert.equal(isHostAllowed(''), false);
    assert.equal(isHostAllowed('bad host!'), false);
  });

  it('accepts loopback only when allowLocalhost is on', () => {
    assert.equal(isHostAllowed('127.0.0.1', { allowLocalhost: true }), true);
    assert.equal(isHostAllowed('localhost', { allowLocalhost: true }), true);
    assert.equal(isHostAllowed('::1', { allowLocalhost: true }), true);
    assert.equal(isHostAllowed('10.0.0.1', { allowLocalhost: true }), false);
    assert.equal(isHostAllowed('0.0.0.0', { allowLocalhost: true }), false);
  });

  it('rejects non-canonical IPv4 literals that resolvers would map to internal addresses', () => {
    assert.equal(isHostAllowed('2130706433'), false);
    assert.equal(isHostAllowed('0x7f000001'), false);
    assert.equal(isHostAllowed('0177.0.0.1'), false);
    assert.equal(isHostAllowed('127.1'), false);
    assert.equal(isHostAllowed('1.2.3.4.5'), false);
    assert.equal(isHostAllowed('7f000001'), false);
    assert.equal(isHostAllowed('0x7f.1'), false);
    assert.equal(isHostAllowed('0x7f.0.0.1'), false);
    assert.equal(isHostAllowed('0x10.1'), false);
    assert.equal(isHostAllowed('10.0x1'), false);
    assert.equal(isHostAllowed('0x7f.0x0.0x0.1'), false);
    assert.equal(isHostAllowed('100.100.100.200'), false);
    assert.equal(isHostAllowed('224.0.0.1'), false);
    assert.equal(isHostAllowed('255.255.255.255'), false);
  });

  it('rejects trailing-dot and *.localhost hosts', () => {
    assert.equal(isHostAllowed('ccxapi.conceal.network.'), false);
    assert.equal(isHostAllowed('node.localhost'), false);
    assert.equal(isHostAllowed('node.localhost', { allowLocalhost: true }), false);
  });

  it('rejects non-canonical and internal IPv6 literals', () => {
    assert.equal(isHostAllowed('::ffff:169.254.169.254'), false);
    assert.equal(isHostAllowed('[::ffff:127.0.0.1]'), false);
    assert.equal(isHostAllowed('::ffff:10.0.0.1'), false);
    assert.equal(isHostAllowed('fd00::5'), false);
    assert.equal(isHostAllowed('fe80::1'), false);
    assert.equal(isHostAllowed('::'), false);
    assert.equal(isHostAllowed('garbage:::1'), false);
    assert.equal(isHostAllowed('[::ffff:8.8.8.8]'), true);
    assert.equal(isHostAllowed('2606:4700::1111'), true);
    assert.equal(isHostAllowed('64:ff9b::1.2.3.4'), true);
    assert.equal(isHostAllowed('64:ff9b::7f00:1'), false);
    assert.equal(isHostAllowed('2002:7f00:1::'), false);
    assert.equal(isHostAllowed('2002:808:808::'), true);
    assert.equal(isHostAllowed('fec0::1'), false);
    assert.equal(isHostAllowed('ff02::1'), false);
    assert.equal(isHostAllowed('2001:db8::101.102.103.104'), true);
    assert.equal(isHostAllowed('::8.8.8.8'), true);
    assert.equal(isHostAllowed('::127.0.0.1'), false);
    assert.equal(isAddressBlocked('::8.8.8.8'), false);
    assert.equal(isAddressBlocked('::127.0.0.1'), true);
  });

  it('classifies resolved addresses for the probe pin', () => {
    assert.equal(isAddressBlocked('127.0.0.1'), true);
    assert.equal(isAddressBlocked('::1'), true);
    assert.equal(isAddressBlocked('::'), true);
    assert.equal(isAddressBlocked('169.254.169.254'), true);
    assert.equal(isAddressBlocked('10.1.2.3'), true);
    assert.equal(isAddressBlocked('192.168.0.5'), true);
    assert.equal(isAddressBlocked('172.16.31.7'), true);
    assert.equal(isAddressBlocked('fe80::1'), true);
    assert.equal(isAddressBlocked('fd12::1'), true);
    assert.equal(isAddressBlocked('::ffff:127.0.0.1'), true);
    assert.equal(isAddressBlocked('100.64.1.1'), true);
    assert.equal(isAddressBlocked('64:ff9b::7f00:1'), true);
    assert.equal(isAddressBlocked('2002:a9fe:a9fe::'), true);
    assert.equal(isAddressBlocked('fec0::1'), true);
    assert.equal(isAddressBlocked('ff02::1'), true);
    assert.equal(isAddressBlocked('not-an-address'), true);
    assert.equal(isAddressBlocked(''), true);
    assert.equal(isAddressBlocked('203.0.113.10'), false);
    assert.equal(isAddressBlocked('8.8.8.8'), false);
    assert.equal(isAddressBlocked('2606:4700::1111'), false);
    assert.equal(isAddressBlocked('::ffff:8.8.8.8'), false);
  });

  it('accepts integer ports in range and rejects the rest', () => {
    assert.equal(isValidPort(16000), true);
    assert.equal(isValidPort('16000'), true);
    assert.equal(isValidPort(1), true);
    assert.equal(isValidPort(65535), true);
    assert.equal(isValidPort(0), false);
    assert.equal(isValidPort(65536), false);
    assert.equal(isValidPort(16000.5), false);
  });

  it('accepts empty or 98-char ccx fee addresses and rejects the rest', () => {
    assert.equal(isValidFeeAddress(''), true);
    assert.equal(isValidFeeAddress(sampleFeeAddress), true);
    assert.equal(isValidFeeAddress('ccx7short'), false);
    assert.equal(isValidFeeAddress(`trx7${'x'.repeat(94)}`), false);
    assert.equal(isValidFeeAddress(42), false);
  });

  it('projects height from the 2026-09-14 tip at 2 min/block', () => {
    assert.equal(expectedHeight(heightAnchorMs), heightAnchor);
    assert.equal(expectedHeight(heightAnchorMs + 120000), heightAnchor + 1);
    assert.equal(
      expectedHeight(heightAnchorMs + 7 * 24 * 60 * 60 * 1000),
      heightAnchor + heightWeekBlocks
    );
  });

  it('rejects a height more than a week ahead and keeps a syncing height', () => {
    assert.equal(isSubmittedHeightAccepted(heightAnchor + heightWeekBlocks, heightAnchorMs), true);
    assert.equal(
      isSubmittedHeightAccepted(heightAnchor + heightWeekBlocks + 1, heightAnchorMs),
      false
    );
    assert.equal(isSubmittedHeightAccepted(100, heightAnchorMs), true);
    assert.equal(isSubmittedHeightAccepted(0, heightAnchorMs), true);
    assert.equal(isSubmittedHeightAccepted(-1, heightAnchorMs), false);
  });
});

describe('sanitizeNodeUpdate', () => {
  it('accepts a conforming payload and keeps the known fields', () => {
    const record = sanitizeNodeUpdate(validBody(), nullLogger);

    assert.ok(record);
    assert.equal(record.id, guardianId);
    assert.equal(record.nodeHost, '203.0.113.10');
    assert.equal(record.nodePort, 16000);
    assert.equal(record.blockchain.height, heightAnchor);
    assert.deepEqual(Object.keys(record), [
      'id',
      'os',
      'name',
      'version',
      'nodeHost',
      'nodePort',
      'status',
      'blockchain',
      'location',
    ]);
  });

  it('drops unknown top-level fields', () => {
    const record = sanitizeNodeUpdate(validBody({ injected: 'value' }), nullLogger);

    assert.ok(record);
    assert.equal(record.injected, undefined);
  });

  it('rejects payloads with an invalid id, host or port', () => {
    assert.equal(sanitizeNodeUpdate(validBody({ id: 'bad id!' }), nullLogger), null);
    assert.equal(sanitizeNodeUpdate(validBody({ id: publicIdHex }), nullLogger), null);
    assert.equal(sanitizeNodeUpdate(validBody({ nodeHost: '127.0.0.1' }), nullLogger), null);
    assert.equal(sanitizeNodeUpdate(validBody({ nodePort: 0 }), nullLogger), null);
    assert.equal(sanitizeNodeUpdate(validBody({ nodePort: 'http' }), nullLogger), null);
  });

  it('rejects out-of-range or wrongly typed blockchain fields', () => {
    assert.equal(sanitizeNodeUpdate(validBody({ blockchain: { height: -5 } }), nullLogger), null);
    assert.equal(
      sanitizeNodeUpdate(
        validBody({ blockchain: { height: heightAnchor + heightWeekBlocks + 1 } }),
        nullLogger,
        heightAnchorMs
      ),
      null
    );
    assert.ok(
      sanitizeNodeUpdate(validBody({ blockchain: { height: 100 } }), nullLogger, heightAnchorMs)
    );
    assert.ok(
      sanitizeNodeUpdate(
        validBody({ blockchain: { height: heightAnchor + heightWeekBlocks } }),
        nullLogger,
        heightAnchorMs
      )
    );
    assert.equal(
      sanitizeNodeUpdate(validBody({ blockchain: { fee_address: 42 } }), nullLogger),
      null
    );
    assert.equal(
      sanitizeNodeUpdate(validBody({ blockchain: { fee_address: 'ccx7short' } }), nullLogger),
      null
    );
    assert.equal(sanitizeNodeUpdate(validBody({ blockchain: { status: {} } }), nullLogger), null);
  });

  it('logs when a submitted height is outside the accepted window', () => {
    const warnings = [];
    const logger = { warn: (msg, meta) => warnings.push({ msg, meta }) };
    const tooHigh = heightAnchor + heightWeekBlocks + 1;

    assert.equal(
      sanitizeNodeUpdate(validBody({ blockchain: { height: tooHigh } }), logger, heightAnchorMs),
      null
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].msg, 'Rejected node height outside accepted window');
    assert.equal(warnings[0].meta.height, tooHigh);
    assert.equal(warnings[0].meta.maxAccepted, heightAnchor + heightWeekBlocks);
  });

  it('drops an invalid custom url but keeps the record', () => {
    const body = validBody({ url: { host: '127.0.0.1', port: 16000 } });
    const record = sanitizeNodeUpdate(body, nullLogger);

    assert.ok(record);
    assert.equal(record.url, undefined);
  });

  it('keeps a domain url when the port is omitted', () => {
    const body = validBody({ url: { host: 'ccxapi.conceal.network/daemon', port: '' } });
    const record = sanitizeNodeUpdate(body, nullLogger);

    assert.ok(record);
    assert.deepEqual(record.url, { host: 'ccxapi.conceal.network/daemon', port: '' });
  });

  it('caps long strings and drops non-primitive location data entries', () => {
    const body = validBody({
      name: 'x'.repeat(500),
      location: { ip: '203.0.113.10', data: { country: 'NL', nested: { deep: true }, ok: 5 } },
    });
    const record = sanitizeNodeUpdate(body, nullLogger);

    assert.ok(record);
    assert.equal(record.name.length, 200);
    assert.equal(record.location.data.country, 'NL');
    assert.equal(record.location.data.nested, undefined);
    assert.equal(record.location.data.ok, 5);
  });

  it('rejects non-object payloads', () => {
    assert.equal(sanitizeNodeUpdate(null, nullLogger), null);
    assert.equal(sanitizeNodeUpdate('payload', nullLogger), null);
    assert.equal(sanitizeNodeUpdate([validBody()], nullLogger), null);
  });
});

describe('applyDaemonInfo', () => {
  // probe time 10 blocks after the anchor keeps every fixture height in window
  const probeNowMs = heightAnchorMs + 10 * blockTimeSeconds * 1000;
  const probeHeight = heightAnchor + 10;

  it('copies daemon-reported values over the submitted data', () => {
    const data = { id: 'node-1', blockchain: { height: probeHeight - 1 } };
    const info = {
      height: probeHeight,
      fee_address: sampleFeeAddress,
      status: 'OK',
      version: '6.0.2',
      hashrate: 1234,
    };

    assert.equal(applyDaemonInfo(data, info, nullLogger, probeNowMs), true);

    assert.equal(data.blockchain.height, probeHeight);
    assert.equal(data.blockchain.fee_address, sampleFeeAddress);
    assert.equal(data.blockchain.status, 'OK');
    assert.equal(data.blockchain.version, '6.0.2');
    assert.equal(data.blockchain.hashrate, 1234);
  });

  it('keeps an in-window daemon height when the claim drifts by more than the tolerance', () => {
    const warnings = [];
    const logger = { warn: (msg) => warnings.push(msg) };
    const data = {
      id: 'node-1',
      blockchain: { height: probeHeight - 10, fee_address: sampleFeeAddress },
    };

    assert.equal(
      applyDaemonInfo(
        data,
        { height: probeHeight, fee_address: sampleFeeAddress, status: 'OK', version: '6.7.5' },
        logger,
        probeNowMs
      ),
      true
    );

    assert.equal(data.blockchain.height, probeHeight);
    assert.equal(data.blockchain.fee_address, sampleFeeAddress);
    assert.equal(data.blockchain.status, 'OK');
    assert.equal(data.blockchain.version, '6.7.5');
    assert.equal(warnings.length, 1);
  });

  it('rejects a far-future daemon height without overwriting anything', () => {
    const data = { id: 'node-1', blockchain: { height: probeHeight } };
    const farFuture = expectedHeight(probeNowMs) + heightWeekBlocks + 5;

    assert.equal(applyDaemonInfo(data, { height: farFuture }, nullLogger, probeNowMs), false);
    assert.equal(data.blockchain.height, probeHeight);
  });

  it('tolerates normal height drift without warning', () => {
    const warnings = [];
    const logger = { warn: (msg) => warnings.push(msg) };
    const data = { id: 'node-1', blockchain: { height: probeHeight - 2 } };

    assert.equal(applyDaemonInfo(data, { height: probeHeight }, logger, probeNowMs), true);
    assert.equal(data.blockchain.height, probeHeight);
    assert.equal(warnings.length, 0);
  });

  it('does not copy an invalid daemon fee_address', () => {
    const data = { id: 'node-1', blockchain: { fee_address: sampleFeeAddress } };

    assert.equal(applyDaemonInfo(data, { fee_address: 'ccx7short' }, nullLogger, probeNowMs), true);
    assert.equal(data.blockchain.fee_address, sampleFeeAddress);
  });

  it('leaves the data untouched on a missing daemon response', () => {
    const data = { id: 'node-1', blockchain: { height: probeHeight } };

    assert.equal(applyDaemonInfo(data, null, nullLogger, probeNowMs), true);
    assert.deepEqual(data.blockchain, { height: probeHeight });
  });
});

describe('probeNode address pinning', () => {
  it('refuses to probe a hostname whose resolved address is blocked', async () => {
    const lookup = mock.method(dns, 'lookup', (_hostname, _options, callback) => {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    });

    try {
      const data = {
        id: 'node-1',
        nodeHost: 'rebound.attacker.example',
        nodePort: 18081,
        status: {},
        blockchain: { height: heightAnchor },
      };

      await new Promise((resolve) => {
        probeNode(data, { logger: nullLogger, apiTimeout: 250 }, resolve);
      });

      assert.equal(data.status.hasSSL, false);
      assert.equal(data.status.isReachable, false);
      assert.equal(data.blockchain.height, heightAnchor);
    } finally {
      lookup.mock.restore();
    }
  });

  it('marks a node reachable when /getinfo is a bare object', async () => {
    const lookup = mock.method(dns, 'lookup', (_hostname, _options, callback) => {
      callback(null, [{ address: '203.0.113.10', family: 4 }]);
    });
    const httpsRequest = mock.method(https, 'request', () => {
      const request = new EventEmitter();

      request.destroy = () => {};
      request.end = () => {
        queueMicrotask(() => request.emit('error', new Error('no tls')));
      };

      return request;
    });
    const httpRequest = mock.method(http, 'request', (_options, callback) => {
      const request = new EventEmitter();

      request.destroy = () => {};
      request.end = () => {
        queueMicrotask(() => {
          const response = new EventEmitter();

          response.statusCode = 200;
          response.resume = () => {};
          response.setEncoding = () => {};
          callback(response);
          response.emit(
            'data',
            JSON.stringify({
              height: heightAnchor,
              status: 'OK',
              version: '6.4.5',
              fee_address: sampleFeeAddress,
            })
          );
          response.emit('end');
        });
      };

      return request;
    });

    try {
      const data = {
        id: 'node-1',
        nodeHost: 'node.example.com',
        nodePort: 16000,
        status: {},
        blockchain: { height: heightAnchor, fee_address: '' },
      };

      await new Promise((resolve) => {
        probeNode(data, { logger: nullLogger, apiTimeout: 500 }, resolve);
      });

      assert.equal(data.status.hasSSL, false);
      assert.equal(data.status.isReachable, true);
      assert.equal(data.blockchain.height, heightAnchor);
      assert.equal(data.blockchain.status, 'OK');
      assert.equal(data.blockchain.version, '6.4.5');
      assert.equal(data.blockchain.fee_address, sampleFeeAddress);
    } finally {
      lookup.mock.restore();
      httpsRequest.mock.restore();
      httpRequest.mock.restore();
    }
  });

  it('does not list a node whose daemon height is outside the accepted window', async () => {
    const farFuture = expectedHeight(Date.now()) + heightWeekBlocks + 50;
    const lookup = mock.method(dns, 'lookup', (_hostname, _options, callback) => {
      callback(null, [{ address: '203.0.113.10', family: 4 }]);
    });
    const httpsRequest = mock.method(https, 'request', () => {
      const request = new EventEmitter();

      request.destroy = () => {};
      request.end = () => {
        queueMicrotask(() => request.emit('error', new Error('no tls')));
      };

      return request;
    });
    const httpRequest = mock.method(http, 'request', (_options, callback) => {
      const request = new EventEmitter();

      request.destroy = () => {};
      request.end = () => {
        queueMicrotask(() => {
          const response = new EventEmitter();

          response.statusCode = 200;
          response.resume = () => {};
          response.setEncoding = () => {};
          callback(response);
          response.emit(
            'data',
            JSON.stringify({ height: farFuture, status: 'OK', version: '6.7.5' })
          );
          response.emit('end');
        });
      };

      return request;
    });

    try {
      const data = {
        id: 'node-1',
        nodeHost: 'node.example.com',
        nodePort: 16000,
        status: {},
        blockchain: { height: heightAnchor },
      };

      await new Promise((resolve) => {
        probeNode(data, { logger: nullLogger, apiTimeout: 500 }, resolve);
      });

      assert.equal(data.status.hasSSL, false);
      assert.equal(data.status.isReachable, false);
      assert.equal(data.blockchain.height, heightAnchor);
      assert.equal(data.blockchain.version, undefined);
    } finally {
      lookup.mock.restore();
      httpsRequest.mock.restore();
      httpRequest.mock.restore();
    }
  });
});

describe('resolveProbeTarget', () => {
  it('uses port 443 when a domain url omits the port', () => {
    const target = resolveProbeTarget({
      url: { host: 'ccxapi.conceal.network/daemon', port: '' },
      nodeHost: '203.0.113.10',
      nodePort: 16000,
    });

    assert.equal(target.host, 'ccxapi.conceal.network/daemon');
    assert.equal(target.port, 443);
  });

  it('uses nodePort when there is no domain url', () => {
    const target = resolveProbeTarget({
      nodeHost: '203.0.113.10',
      nodePort: 16000,
    });

    assert.equal(target.host, '203.0.113.10');
    assert.equal(target.port, 16000);
  });
});
