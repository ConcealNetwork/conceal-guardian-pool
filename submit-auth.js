// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const crypto = require('node:crypto');

// DER SPKI prefix that turns a raw 32-byte ed25519 public key into a parseable key
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const publicKeyPattern = /^[0-9a-f]{64}$/;
const signaturePattern = /^[0-9a-f]{128}$/;
const messageVersion = 'ccx-pool-update-v1';

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

// Canonical signed message: the signature binds the envelope timestamp and the
// exact submitted id, host and port, so a captured payload cannot be re-pointed
// at another listing and a replay only re-asserts an identical binding.
const submitAuthMessage = (body) =>
  [
    messageVersion,
    String(body.auth.timestamp),
    String(body.id),
    String(body.nodeHost),
    String(body.nodePort),
  ].join('\n');

// Verify the proof-of-ownership envelope on a /pool/update payload. A missing
// envelope is reported as { verified: false, reason: 'missing' } so the
// transition policy can still accept unsigned submitters; any envelope that is
// present but invalid is rejected and never downgraded to anonymous.
const verifySubmitAuth = (body, { maxSkewMs, nowMs = Date.now() }) => {
  if (!isPlainObject(body)) {
    return { verified: false, reason: 'missing' };
  }

  if (body.auth === undefined) {
    return { verified: false, reason: 'missing' };
  }

  if (!isPlainObject(body.auth)) {
    return { verified: false, reason: 'invalid-envelope' };
  }

  const publicKey =
    typeof body.auth.publicKey === 'string' ? body.auth.publicKey.toLowerCase() : '';
  const signature =
    typeof body.auth.signature === 'string' ? body.auth.signature.toLowerCase() : '';
  const timestamp = Number(body.auth.timestamp);

  if (!publicKeyPattern.test(publicKey)) {
    return { verified: false, reason: 'invalid-key' };
  }

  if (!signaturePattern.test(signature)) {
    return { verified: false, reason: 'invalid-signature' };
  }

  if (!Number.isFinite(timestamp) || Math.abs(nowMs - timestamp) > maxSkewMs) {
    return { verified: false, reason: 'stale-timestamp' };
  }

  let key;

  try {
    key = crypto.createPublicKey({
      key: Buffer.concat([spkiPrefix, Buffer.from(publicKey, 'hex')]),
      format: 'der',
      type: 'spki',
    });
  } catch (_error) {
    return { verified: false, reason: 'invalid-key' };
  }

  const verified = crypto.verify(
    null,
    Buffer.from(submitAuthMessage(body), 'utf8'),
    key,
    Buffer.from(signature, 'hex')
  );

  return verified ? { verified: true, publicKey } : { verified: false, reason: 'bad-signature' };
};

// Once an id is claimed by a key, only that key may keep updating it.
const ownershipAllowsUpdate = ({ registry, id, verified, publicKey }) => {
  const claimed = registry.get(id);

  return !claimed || (verified === true && publicKey === claimed);
};

// A verified listing can only be evicted from its host:port slot by its own key.
const ownershipAllowsEviction = ({ registry, occupantId, verified, publicKey }) => {
  const claimed = registry.get(occupantId);

  return !claimed || (verified === true && publicKey === claimed);
};

// Bound how many concurrent listings one identity may hold so a single key
// cannot out-fill the reserved verified budget either.
const identityAllowsNewListing = ({ registry, id, publicKey, maxListingsPerKey, registryCap }) => {
  let held = 0;

  for (const key of registry.values()) {
    if (key === publicKey) {
      held++;
    }
  }

  return held < maxListingsPerKey && (registry.has(id) || registry.size < registryCap);
};

module.exports = {
  identityAllowsNewListing,
  ownershipAllowsEviction,
  ownershipAllowsUpdate,
  submitAuthMessage,
  verifySubmitAuth,
};
