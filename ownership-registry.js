// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

// RAM-only registry binding verified node ids to their ed25519 public keys.
// Never persisted: a restart forgets ownership until owners re-submit a
// signed update. The pending set tracks ids with an in-flight registration
// so two things stay true at once:
// - claimForUpdate is synchronous, so two concurrent signed submissions for
//   the same unclaimed id cannot both enter the registration flow — the
//   second one is refused while the first is still probing;
// - reconciliation can drop claims whose listing expired or was evicted from
//   the cache without discarding a claim that is still being earned.
const pendingClaimGraceMs = 30000; // probe budget is 3s; generous margin

const createOwnershipRegistry = () => {
  const claims = new Map();
  const pending = new Map();

  // Drop claims whose listing is no longer in the cache (TTL expiry, eviction,
  // host:port move). In-flight reservations are protected by the pending set
  // and abandoned reservations are reaped after the grace period. The caller
  // supplies the live id set so the registry stays decoupled from any
  // particular cache implementation.
  const reconcile = (liveIds, now = Date.now()) => {
    for (const [id, reservedAt] of pending) {
      if (now - reservedAt >= pendingClaimGraceMs) {
        pending.delete(id);
      }
    }

    for (const id of claims.keys()) {
      if (!liveIds.has(id) && !pending.has(id)) {
        claims.delete(id);
      }
    }
  };

  return {
    claims,
    pending,
    // Synchronous reserve step: returns false when the id is already claimed,
    // true otherwise. Because it never awaits, the check-and-set is atomic
    // with respect to every other request.
    claimForUpdate: (id, publicKey, now = Date.now()) => {
      if (claims.has(id)) {
        return false;
      }

      claims.set(id, publicKey);
      pending.set(id, now);
      return true;
    },
    // Roll an in-flight reservation back when its listing never landed, so a
    // failed registration cannot squat the id or count against the bounds.
    // Only the key that holds the claim may release it.
    release: (id, publicKey) => {
      if (claims.get(id) === publicKey) {
        claims.delete(id);
        pending.delete(id);
      }
    },
    // Commit an in-flight reservation (idempotent for an already-held claim).
    confirm: (id, publicKey) => {
      claims.set(id, publicKey);
      pending.delete(id);
    },
    reconcile,
  };
};

module.exports = { createOwnershipRegistry, pendingClaimGraceMs };
