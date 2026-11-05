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

    // entries are appended in publication order; maxHeight reads the last one
    maxHeight: () => (entries.length > 0 ? entries.at(-1).height : null),

    size: () => entries.length,
  };
};

// prior tips first, then the anchor, so the last entry stays the newest tip
const fillFreshAnchor = (ring, anchor, priorTips) => {
  if (Array.isArray(priorTips)) {
    for (const tip of priorTips) {
      ring.push(tip);
    }
  }

  ring.push(anchor);
};

module.exports = { createAnchorRing, fillFreshAnchor };
