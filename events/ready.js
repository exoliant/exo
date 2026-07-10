const fs = require('fs');
const path = require('path');

const BlueprintManager = require('../managers/BlueprintManager');
const RestoreManager = require('../managers/RestoreManager');

const BLUEPRINT_DIR = path.join(__dirname, '..', 'data', 'blueprints');
const WHITELIST_DIR = path.join(__dirname, '..', 'data', 'whitelist');
const TEMP_DIR = path.join(__dirname, '..', 'temp');

function countJsonFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

module.exports = {
  name: 'ready',
  once: true,
  async execute(client) {
    console.log(`✓ Connected to Discord as ${client.user.tag}`);
    console.log(`✓ Loaded ${client.commandCount} command(s)`);
    console.log(`✓ Loaded ${client.eventCount} event(s)`);
    console.log(`✓ Loaded ${countJsonFiles(BLUEPRINT_DIR)} guild blueprint(s)`);
    console.log(`✓ Loaded ${countJsonFiles(WHITELIST_DIR)} whitelist file(s)`);
    console.log('✓ RestoreManager initialized');
    console.log('✓ AuditManager initialized');

    await recoverFromCrash(client);
    await RestoreManager.resumeQuarantines(client);
  },
};

/**
 * If the bot crashed or was killed mid-restoration, a restoring-<guildId>.lock
 * file will still be on disk even though the in-memory isRestoring flag has
 * reset to false on this fresh process. A stale lock doesn't tell us how far
 * the interrupted restoration got, so the safe move is: remove the lock (it's
 * just a debug artifact at this point) and re-run a full restore for that
 * guild, since restoreFull is idempotent - anything already correctly
 * recreated will simply not show up as "missing" in the diff.
 */
async function recoverFromCrash(client) {
  if (!fs.existsSync(TEMP_DIR)) return;

  const lockFiles = fs
    .readdirSync(TEMP_DIR)
    .filter((f) => f.startsWith('restoring-') && f.endsWith('.lock'));

  if (lockFiles.length === 0) return;

  for (const lockFile of lockFiles) {
    const guildId = lockFile.replace('restoring-', '').replace('.lock', '');

    console.warn(
      `[Startup] Found a stale restoring.lock for guild ${guildId} - a previous restoration was likely interrupted by a crash or restart.`
    );

    try {
      fs.unlinkSync(path.join(TEMP_DIR, lockFile));
    } catch (err) {
      console.error(`[Startup] Failed to remove stale lock for ${guildId}:`, err);
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      console.warn(`[Startup] Guild ${guildId} is not currently available; skipping recovery for it.`);
      continue;
    }

    if (!BlueprintManager.exists(guildId)) {
      console.warn(`[Startup] No blueprint on file for ${guildId}; cannot resume restoration.`);
      continue;
    }

    console.log(`[Startup] Resuming interrupted restoration for guild ${guildId}...`);
    RestoreManager.restoreFull(guild, 'resumed-after-crash').catch((err) => {
      console.error(`[Startup] Resumed restoration failed for ${guildId}:`, err);
    });
  }
    }
