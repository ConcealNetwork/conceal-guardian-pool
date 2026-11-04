const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  identityAllowsNewListing,
  ownershipAllowsEviction,
  ownershipAllowsUpdate,
  submitAuthMessage,
  verifySubmitAuth,
} = require('../submit-auth');
const { sanitizeNodeUpdate } = require('../sanitize');

const nullLogger = { warn: () => {}, error: () => {}, info: () => {} };
const guardianId = '550e8400-e29b-41d4-a716-446655440000';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const publicKeyHex = publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('hex');
const { privateKey: otherKey } = crypto.generateKeyPairSync('ed25519');

function validBody(overrides) {
  return Object.assign(
    {
      id: guardianId,
      os: 'linux',
      name: 'node-1',
      version: '6.0.0',
      nodeHost: '203.0.113.10',
      nodePort: 16000,
    },
    overrides
  );
}

function signedBody(body, overrides = {}) {
  body.auth = {
    publicKey: overrides.publicKey ?? publicKeyHex,
    signature: '00'.repeat(64),
    timestamp: overrides.timestamp ?? 1762200000000,
  };

  const key = overrides.key ?? privateKey;

  body.auth.signature = crypto
    .sign(null, Buffer.from(submitAuthMessage(body), 'utf8'), key)
    .toString('hex');

  return body;
}

describe('submitAuthMessage', () => {
  it('binds the version, timestamp and the exact identity fields', () => {
    const body = signedBody(validBody(), { timestamp: 1762200000000 });

    assert.equal(
      submitAuthMessage(body),
      ['ccx-pool-update-v1', '1762200000000', guardianId, '203.0.113.10', '16000'].join('\n')
    );
  });
});

describe('verifySubmitAuth', () => {
  const options = { maxSkewMs: 300000, nowMs: 1762200000000 };

  it('reports a missing envelope so the transition policy can decide', () => {
    assert.deepEqual(verifySubmitAuth(validBody(), options), {
      verified: false,
      reason: 'missing',
    });
    assert.deepEqual(verifySubmitAuth(null, options), { verified: false, reason: 'missing' });
    assert.deepEqual(verifySubmitAuth('payload', options), {
      verified: false,
      reason: 'missing',
    });
  });

  it('rejects an envelope that is present but not an object', () => {
    assert.deepEqual(verifySubmitAuth(validBody({ auth: 'junk' }), options), {
      verified: false,
      reason: 'invalid-envelope',
    });
    assert.deepEqual(verifySubmitAuth(validBody({ auth: [1] }), options), {
      verified: false,
      reason: 'invalid-envelope',
    });
  });

  it('verifies a well-formed ed25519 envelope case-insensitively', () => {
    const body = signedBody(validBody());

    assert.deepEqual(verifySubmitAuth(body, options), { verified: true, publicKey: publicKeyHex });

    body.auth.signature = body.auth.signature.toUpperCase();
    body.auth.publicKey = body.auth.publicKey.toUpperCase();

    assert.deepEqual(verifySubmitAuth(body, options), { verified: true, publicKey: publicKeyHex });
  });

  it('rejects any tampering with the signed fields', () => {
    const body = signedBody(validBody());
    const tampered = validBody({ id: '550e8400-e29b-41d4-a716-446655440001' });
    tampered.auth = body.auth;

    assert.deepEqual(verifySubmitAuth(tampered, options), {
      verified: false,
      reason: 'bad-signature',
    });

    const moved = signedBody(validBody());
    moved.nodePort = 16001;

    assert.deepEqual(verifySubmitAuth(moved, options), {
      verified: false,
      reason: 'bad-signature',
    });

    const rehosted = signedBody(validBody());
    rehosted.nodeHost = '203.0.113.11';

    assert.deepEqual(verifySubmitAuth(rehosted, options), {
      verified: false,
      reason: 'bad-signature',
    });
  });

  it('rejects a signature from another key', () => {
    const body = signedBody(validBody(), { key: otherKey });

    assert.deepEqual(verifySubmitAuth(body, options), {
      verified: false,
      reason: 'bad-signature',
    });
  });

  it('rejects an envelope timestamp outside the skew window', () => {
    assert.deepEqual(
      verifySubmitAuth(signedBody(validBody(), { timestamp: 1762199699999 }), options),
      { verified: false, reason: 'stale-timestamp' }
    );
    assert.deepEqual(
      verifySubmitAuth(signedBody(validBody(), { timestamp: 1762200300001 }), options),
      { verified: false, reason: 'stale-timestamp' }
    );
    assert.equal(
      verifySubmitAuth(signedBody(validBody(), { timestamp: 1762200300000 }), options).verified,
      true
    );
    assert.deepEqual(verifySubmitAuth(signedBody(validBody(), { timestamp: 'soon' }), options), {
      verified: false,
      reason: 'stale-timestamp',
    });
  });

  it('rejects malformed keys and signatures before any crypto work', () => {
    assert.deepEqual(
      verifySubmitAuth(signedBody(validBody(), { publicKey: 'zz'.repeat(32) }), options),
      { verified: false, reason: 'invalid-key' }
    );
    assert.deepEqual(
      verifySubmitAuth(signedBody(validBody(), { publicKey: 'ab'.repeat(31) }), options),
      { verified: false, reason: 'invalid-key' }
    );
    assert.deepEqual(verifySubmitAuth(signedBody(validBody(), { publicKey: 42 }), options), {
      verified: false,
      reason: 'invalid-key',
    });

    const shortSignature = signedBody(validBody());
    shortSignature.auth.signature = 'ab'.repeat(31);

    assert.deepEqual(verifySubmitAuth(shortSignature, options), {
      verified: false,
      reason: 'invalid-signature',
    });

    const badSignature = signedBody(validBody());
    badSignature.auth.signature = 'zz'.repeat(64);

    assert.deepEqual(verifySubmitAuth(badSignature, options), {
      verified: false,
      reason: 'invalid-signature',
    });
  });

  it('never leaks the auth envelope into the stored record', () => {
    const record = sanitizeNodeUpdate(signedBody(validBody()), nullLogger);

    assert.ok(record);
    assert.equal(record.auth, undefined);
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
});

describe('ownership policy helpers', () => {
  const verified = { verified: true, publicKey: publicKeyHex };

  it('allows an unclaimed id to any submitter', () => {
    const registry = new Map();

    assert.equal(
      ownershipAllowsUpdate({ registry, id: guardianId, verified: false, publicKey: undefined }),
      true
    );
  });

  it('restricts a claimed id to its own key', () => {
    const registry = new Map([[guardianId, publicKeyHex]]);

    assert.equal(
      ownershipAllowsUpdate({
        registry,
        id: guardianId,
        verified: verified.verified,
        publicKey: verified.publicKey,
      }),
      true
    );
    assert.equal(ownershipAllowsUpdate({ registry, id: guardianId, verified: false }), false);
    assert.equal(
      ownershipAllowsUpdate({
        registry,
        id: guardianId,
        verified: true,
        publicKey: 'ff'.repeat(32),
      }),
      false
    );
  });

  it('protects a claimed occupant from eviction by any other submitter', () => {
    const registry = new Map([[guardianId, publicKeyHex]]);

    assert.equal(
      ownershipAllowsEviction({
        registry,
        occupantId: guardianId,
        verified: verified.verified,
        publicKey: verified.publicKey,
      }),
      true
    );
    assert.equal(
      ownershipAllowsEviction({ registry, occupantId: guardianId, verified: false }),
      false
    );
    assert.equal(
      ownershipAllowsEviction({
        registry,
        occupantId: guardianId,
        verified: true,
        publicKey: 'ff'.repeat(32),
      }),
      false
    );
    assert.equal(
      ownershipAllowsEviction({ registry, occupantId: 'unclaimed', verified: false }),
      true
    );
  });

  it('bounds listings per identity and the registry capacity', () => {
    const registry = new Map();

    for (let i = 0; i < 8; i++) {
      registry.set(`id-${i}`, publicKeyHex);
    }

    assert.equal(
      identityAllowsNewListing({
        registry,
        id: 'id-new',
        publicKey: publicKeyHex,
        maxListingsPerKey: 8,
        registryCap: 500,
      }),
      false
    );

    registry.delete('id-0');

    assert.equal(
      identityAllowsNewListing({
        registry,
        id: 'id-new',
        publicKey: publicKeyHex,
        maxListingsPerKey: 8,
        registryCap: 500,
      }),
      true
    );

    const full = new Map();

    for (let i = 0; i < 500; i++) {
      full.set(`id-${i}`, 'ff'.repeat(32));
    }

    assert.equal(
      identityAllowsNewListing({
        registry: full,
        id: 'id-new',
        publicKey: publicKeyHex,
        maxListingsPerKey: 8,
        registryCap: 500,
      }),
      false
    );
  });
});
