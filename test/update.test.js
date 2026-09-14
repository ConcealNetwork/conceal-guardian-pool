const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isHostAllowed, isValidNodeId, isValidPort } = require('../validate');
const { sanitizeNodeUpdate } = require('../sanitize');
const { applyDaemonInfo } = require('../probe');

const nullLogger = { warn: () => {}, error: () => {}, info: () => {} };

function validBody(overrides) {
  return Object.assign(
    {
      id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      os: 'linux',
      name: 'node-1',
      version: '6.0.0',
      nodeHost: '203.0.113.10',
      nodePort: 16000,
      status: { errors: 0, startTime: '2026-01-01T00:00:00Z', initialized: true },
      blockchain: { height: 2953345, fee_address: 'ccx7SampleFeeAddressZZ', status: 'OK' },
      location: { ip: '203.0.113.10', data: { country: 'NL' } },
    },
    overrides
  );
}

describe('validate', () => {
  it('accepts well-formed node ids and rejects malformed ones', () => {
    assert.equal(isValidNodeId('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), true);
    assert.equal(isValidNodeId('node_A-1'), true);
    assert.equal(isValidNodeId(''), false);
    assert.equal(isValidNodeId('bad id!'), false);
    assert.equal(isValidNodeId('x'.repeat(101)), false);
    assert.equal(isValidNodeId(42), false);
  });

  it('accepts valid hosts and rejects loopback, link-local and malformed ones', () => {
    assert.equal(isHostAllowed('203.0.113.10'), true);
    assert.equal(isHostAllowed('node1.example.com'), true);
    assert.equal(isHostAllowed('2001:db8::1'), true);
    assert.equal(isHostAllowed('127.0.0.1'), false);
    assert.equal(isHostAllowed('localhost'), false);
    assert.equal(isHostAllowed('169.254.1.1'), false);
    assert.equal(isHostAllowed('::1'), false);
    assert.equal(isHostAllowed(''), false);
    assert.equal(isHostAllowed('bad host!'), false);
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
});

describe('sanitizeNodeUpdate', () => {
  it('accepts a conforming payload and keeps the known fields', () => {
    const record = sanitizeNodeUpdate(validBody(), nullLogger);

    assert.ok(record);
    assert.equal(record.id, '3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    assert.equal(record.nodeHost, '203.0.113.10');
    assert.equal(record.nodePort, 16000);
    assert.equal(record.blockchain.height, 2953345);
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
    assert.equal(sanitizeNodeUpdate(validBody({ nodeHost: '127.0.0.1' }), nullLogger), null);
    assert.equal(sanitizeNodeUpdate(validBody({ nodePort: 0 }), nullLogger), null);
    assert.equal(sanitizeNodeUpdate(validBody({ nodePort: 'http' }), nullLogger), null);
  });

  it('rejects out-of-range or wrongly typed blockchain fields', () => {
    assert.equal(sanitizeNodeUpdate(validBody({ blockchain: { height: -5 } }), nullLogger), null);
    assert.equal(
      sanitizeNodeUpdate(validBody({ blockchain: { height: 100000001 } }), nullLogger),
      null
    );
    assert.equal(
      sanitizeNodeUpdate(validBody({ blockchain: { fee_address: 42 } }), nullLogger),
      null
    );
    assert.equal(sanitizeNodeUpdate(validBody({ blockchain: { status: {} } }), nullLogger), null);
  });

  it('drops an invalid custom url but keeps the record', () => {
    const body = validBody({ url: { host: '127.0.0.1', port: 16000 } });
    const record = sanitizeNodeUpdate(body, nullLogger);

    assert.ok(record);
    assert.equal(record.url, undefined);
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
      fee_address: 'ccxDaemonFeeAddress',
      status: 'OK',
      version: '6.0.2',
      hashrate: 1234,
    };

    applyDaemonInfo(data, info, nullLogger);

    assert.equal(data.blockchain.height, 2953345);
    assert.equal(data.blockchain.fee_address, 'ccxDaemonFeeAddress');
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

  it('leaves the data untouched on a missing daemon response', () => {
    const data = { id: 'node-1', blockchain: { height: 100 } };

    applyDaemonInfo(data, null, nullLogger);

    assert.deepEqual(data.blockchain, { height: 100 });
  });
});
