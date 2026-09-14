// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const shell = require('shelljs');
const path = require('node:path');
const fs = require('node:fs');

module.exports = {
  ensureUserDataDir: () => {
    let userDataDir =
      process.env.APPDATA ||
      (process.platform === 'darwin'
        ? `${process.env.HOME}/Library/Application Support`
        : `${process.env.HOME}/.local/share`);
    userDataDir = path.join(userDataDir, 'ccxNodePool');

    if (!fs.existsSync(userDataDir)) {
      shell.mkdir('-p', userDataDir);
    }

    return userDataDir;
  },
};
