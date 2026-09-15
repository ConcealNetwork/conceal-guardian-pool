// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const cors = require('cors');

const CONCEAL_ORIGINS = [
  'http://explorer.conceal.network',
  'https://explorer.conceal.network',
  'http://newexplorer.conceal.network',
  'https://newexplorer.conceal.network',
  'https://wws.conceal.network',
  'https://wallet.conceal.network',
];

/** Anyone may GET (browser or otherwise). */
const publicGetCors = cors({
  origin: '*',
  methods: ['GET'],
  allowedHeaders: ['Content-Type'],
  credentials: false,
});

/** Conceal UIs may POST/OPTIONS with credentials. Non-browser (no Origin) is unaffected. */
const concealWriteCors = cors({
  origin: CONCEAL_ORIGINS,
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
});

module.exports = {
  CONCEAL_ORIGINS,
  publicGetCors,
  concealWriteCors,
};
