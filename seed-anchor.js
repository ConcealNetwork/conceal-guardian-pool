// Copyright (c) 2019 -2026, Acktarius, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const { blockTimeSeconds, isSubmittedHeightAccepted } = require('./validate.js');

const tipHashPattern = /^[0-9a-f]{64}$/i;
const anchorHoldMs = 12 * 60 * 1000;
const minOnHeight = 3;
const blockMs = blockTimeSeconds * 1000;
// blocks the chain can advance while a held anchor waits for the next agreement
const maxAnchorSlackBlocks = Math.floor(anchorHoldMs / blockMs);

const isCountedSeedReply = (reply, nowMs = Date.now()) => {
  if (!reply || typeof reply !== 'object') {
    return false;
  }

  if (reply.status !== 'OK' || !Number.isInteger(reply.height)) {
    return false;
  }

  if (!isSubmittedHeightAccepted(reply.height, nowMs)) {
    return false;
  }

  return typeof reply.top_block_hash === 'string' && tipHashPattern.test(reply.top_block_hash);
};

// Even count: the lower of the two central heights, which is always one of the samples.
const lowerMedian = (heights) => {
  const sorted = [...heights].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }

  return sorted[mid - 1];
};

// Publish only when three counted replies sit on the chosen height and share one tip hash.
const publishAnchor = (replies, nowMs = Date.now()) => {
  const counted = [];

  for (const reply of replies) {
    if (!isCountedSeedReply(reply, nowMs)) {
      continue;
    }

    counted.push({
      height: reply.height,
      hash: reply.top_block_hash.toLowerCase(),
    });
  }

  if (counted.length < minOnHeight) {
    return null;
  }

  const height = lowerMedian(counted.map((row) => row.height));
  const onHeight = counted.filter((row) => row.height === height);

  if (onHeight.length < minOnHeight) {
    return null;
  }

  const hash = onHeight[0].hash;

  if (onHeight.some((row) => row.hash !== hash)) {
    return null;
  }

  return { height, hash };
};

// A failed round keeps the previous anchor until the hold elapses. nowMs is the
// wall clock for the height window. elapsedMs is the hold clock, so a wall-clock
// step does not expire or extend the anchor. Callers that pass one clock for
// both leave elapsedMs unset.
const nextAnchor = (
  previous,
  replies,
  nowMs = Date.now(),
  holdMs = anchorHoldMs,
  elapsedMs = nowMs
) => {
  const published = publishAnchor(replies, nowMs);

  if (published) {
    return { height: published.height, hash: published.hash, at: elapsedMs };
  }

  if (previous && Number.isInteger(previous.at) && elapsedMs - previous.at < holdMs) {
    return previous;
  }

  return null;
};

// whole blocks the chain may have advanced past an anchor of this age. elapsedMs
// is the same hold clock as nextAnchor. A fresh anchor gives 0; the result stops
// at the blocks that fit in the hold.
const anchorSlackBlocks = (anchor, elapsedMs) => {
  if (!anchor || !Number.isInteger(anchor.at) || !Number.isFinite(elapsedMs)) {
    return 0;
  }

  const age = Math.max(0, elapsedMs - anchor.at);

  return Math.min(maxAnchorSlackBlocks, Math.floor(age / blockMs));
};

module.exports = {
  anchorHoldMs,
  anchorSlackBlocks,
  isCountedSeedReply,
  lowerMedian,
  maxAnchorSlackBlocks,
  minOnHeight,
  nextAnchor,
  publishAnchor,
};
