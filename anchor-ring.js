// Copyright (c) 2019 -2026, Acktarius, The Conceal Developers
//
// Please see the included LICENSE file for more information.

// Trailing ring of published seed anchor tips. Every time the pool publishes an
// anchor (height, hash) the ring records it, one entry per height, oldest evicted
// once the ring is at depth. No RPCs: the ring is fed only from the publications
// the pool already makes on its regular seed refresh.
const createAnchorRing = (depth) => {
  const limit = Number.isInteger(depth) && depth >= 1 ? depth : 20;
  const entries = [];

  return {
    // distinct by height: a re-publication of the same height refreshes its hash,
    // so the newest anchor verdict always wins
    push(anchor) {
      if (!anchor || !Number.isInteger(anchor.height) || anchor.height < 0) {
        return;
      }

      if (typeof anchor.hash !== 'string' || anchor.hash === '') {
        return;
      }

      const hash = anchor.hash.toLowerCase();
      const existing = entries.find((entry) => entry.height === anchor.height);

      if (existing) {
        existing.hash = hash;
        return;
      }

      entries.push({ height: anchor.height, hash });

      while (entries.length > limit) {
        entries.shift();
      }
    },

    entries: () => entries.map((entry) => ({ ...entry })),

    // Monotonic-height assumption: entries are appended in publication order,
    // so maxHeight reads the last entry. A seed height regression would make
    // maxHeight under-report until the ring advances. nextAnchor's 15 min hold
    // makes regressions rare; the impact is limited to a temporarily tighter
    // grace band, and it self-heals.
    maxHeight: () => (entries.length > 0 ? entries[entries.length - 1].height : null),

    size: () => entries.length,
  };
};

module.exports = { createAnchorRing };
