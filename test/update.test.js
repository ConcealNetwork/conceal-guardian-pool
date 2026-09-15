const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  expectedHeight,
  heightAnchor,
  heightAnchorMs,
  heightWeekBlocks,
  isHostAllowed,
  isSubmittedHeightAccepted,
  isValidFeeAddress,
  isValidNodeId,
  isValidPort,
} = require('../validate');
const { sanitizeNodeUpdate } = require('../sanitize');
const { applyDaemonInfo, resolveProbeTarget } = require('../probe');

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
    assert.equal(isHostAllowed('10.0.0.1', { allowLocalhost: true }), false);
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
  it('copies daemon-reported values over the submitted data', () => {
    const data = { id: 'node-1', blockchain: { height: 2953340 } };
    const info = {
      height: 2953345,
      fee_address: sampleFeeAddress,
      status: 'OK',
      version: '6.0.2',
      hashrate: 1234,
    };

    applyDaemonInfo(data, info, nullLogger);

    assert.equal(data.blockchain.height, 2953345);
    assert.equal(data.blockchain.fee_address, sampleFeeAddress);
    assert.equal(data.blockchain.status, 'OK');
    assert.equal(data.blockchain.version, '6.0.2');
    assert.equal(data.blockchain.hashrate, 1234);
  });

  it('keeps the daemon height when the submitted one drifts too far', () => {
    const warnings = [];
    const logger = { warn: (msg) => warnings.push(msg) };
    const data = { id: 'node-1', blockchain: { height: 100 } };

    applyDaemonInfo(data, { height: 2953345 }, logger);

    assert.equal(data.blockchain.height, 2953345);
    assert.equal(warnings.length, 1);
  });

  it('tolerates normal height drift without warning', () => {
    const warnings = [];
    const logger = { warn: (msg) => warnings.push(msg) };
    const data = { id: 'node-1', blockchain: { height: 2953344 } };

    applyDaemonInfo(data, { height: 2953345 }, logger);

    assert.equal(data.blockchain.height, 2953345);
    assert.equal(warnings.length, 0);
  });

  it('does not copy an invalid daemon fee_address', () => {
    const data = { id: 'node-1', blockchain: { fee_address: sampleFeeAddress } };

    applyDaemonInfo(data, { fee_address: 'ccx7short' }, nullLogger);

    assert.equal(data.blockchain.fee_address, sampleFeeAddress);
  });

  it('leaves the data untouched on a missing daemon response', () => {
    const data = { id: 'node-1', blockchain: { height: 100 } };

    applyDaemonInfo(data, null, nullLogger);

    assert.deepEqual(data.blockchain, { height: 100 });
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
