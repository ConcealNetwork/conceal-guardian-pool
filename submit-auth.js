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
// at another listing and a replay only re-asserts an identical binding. Every
// field is length-prefixed with its byte length, so a future validation drift
// that lets separator or newline bytes into a field still cannot make one
// field's bytes be read as another field's.
const submitAuthMessage = (body) =>
  [
    messageVersion,
    String(body.auth.timestamp),
    String(body.id),
    String(body.nodeHost),
    String(body.nodePort),
  ]
    .map((field) => `${Buffer.byteLength(field)}:${field}`)
    .join(':');

// RAM-only replay guard: the first presentation of a signature is remembered
// for ttlMs and any later presentation of the same signature inside that span
// is rejected. ttlMs should cover the widest span over which one signature
// stays valid: a signature minted at the oldest edge of the skew window stays
// acceptable until the newest edge, i.e. twice maxSkewMs. Entries are pruned
// lazily on each check, so memory stays bounded by the traffic inside one
// ttl span. Residual: a process restart forgets seen signatures (a captured
// payload can be replayed once after a restart), and the check runs after the
// envelope itself verified, so junk signatures never occupy memory.
const createReplayGuard = ({ ttlMs = 600000, nowMs = Date.now } = {}) => {
  const seen = new Map();

  return {
    checkAndRecord: (signature) => {
      const now = nowMs();

      for (const [fingerprint, expiresAt] of seen) {
        if (expiresAt <= now) {
          seen.delete(fingerprint);
        }
      }

      const fingerprint = crypto
        .createHash('sha256')
        .update(String(signature).toLowerCase(), 'utf8')
        .digest('hex');

      if (seen.has(fingerprint)) {
        return false;
      }

      seen.set(fingerprint, now + ttlMs);
      return true;
    },
    size: () => seen.size,
  };
};

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

  // The skew window compares a client-supplied timestamp against the server
  // wall clock. That clock is server-owned, but a backward wall-clock step
  // (NTP correction) re-opens the window for signatures minted before the
  // step; a monotonic server clock alone cannot close that. The replay guard
  // wired into index.js covers the practical surface (a replayed signature is
  // rejected regardless of the wall clock, for 2x maxSkew from first sight);
  // the residual (first-seen-after-step signatures, and a restart lapse) is
  // disclosed in the PR description.
  if (!Number.isInteger(timestamp) || Math.abs(nowMs - timestamp) > maxSkewMs) {
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
// cannot out-fill the reserved verified budget either. An id already held by
// its own key is always admitted: refreshing or moving a held listing must
// never be blocked by the bound, only genuinely new listings count.
const identityAllowsNewListing = ({ registry, id, publicKey, maxListingsPerKey, registryCap }) => {
  if (registry.has(id)) {
    return true;
  }

  let held = 0;

  for (const key of registry.values()) {
    if (key === publicKey) {
      held++;
    }
  }

  return held < maxListingsPerKey && registry.size < registryCap;
};

module.exports = {
  createReplayGuard,
  identityAllowsNewListing,
  ownershipAllowsEviction,
  ownershipAllowsUpdate,
  submitAuthMessage,
  verifySubmitAuth,
};
