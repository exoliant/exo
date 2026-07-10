const fs = require('fs');
const path = require('path');

const REQUIRED_DIRS = [
  'data/blueprints',
  'data/whitelist',
  'data/settings',
  'data/cache',
  'data/logs',
  'temp',
];

/**
 * Creates every directory the bot depends on if it doesn't already exist.
 * Called once at startup so a fresh deployment doesn't need any manual
 * filesystem prep.
 */
function ensureDataDirectories(rootDir) {
  for (const rel of REQUIRED_DIRS) {
    const full = path.join(rootDir, rel);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(full, { recursive: true });
      console.log(`[Bootstrap] Created missing directory: ${rel}`);
    }
  }
}

module.exports = { ensureDataDirectories, REQUIRED_DIRS };
