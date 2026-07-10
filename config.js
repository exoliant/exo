require('dotenv').config();

const config = {
  token: process.env.DISCORD_TOKEN,
  ownerId: process.env.OWNER_ID, // only this user can run !save and !whitelist
  prefix: process.env.PREFIX || '!',
  // Free-hosting keep-alive settings - see utils/keepAlive.js. Irrelevant
  // on always-on hosting; harmless to leave enabled anywhere.
  port: process.env.PORT || 3000,
  // Several PaaS hosts automatically inject the app's public URL as an env
  // var - use it if present, so users don't have to manually find and
  // copy/paste their platform-assigned URL into KEEP_ALIVE_URL themselves.
  // Checked in order: explicit override, then Koyeb, then Render.
  keepAliveUrl:
    process.env.KEEP_ALIVE_URL ||
    (process.env.KOYEB_PUBLIC_DOMAIN ? `https://${process.env.KOYEB_PUBLIC_DOMAIN}/` : null) ||
    (process.env.RENDER_EXTERNAL_URL || null),
  keepAliveEnabled: process.env.KEEP_ALIVE !== 'false', // default on; set KEEP_ALIVE=false to disable
  accidentWindowMs: 3 * 60 * 1000, // 3 minutes
  thresholds: {
    channelDeletes: 5,
    roleDeletes: 5,
    categoryChannelCount: 2, // category deletion is malicious if it contained >= this many channels
    banKickMalicious: 3, // combined bans+kicks within accidentWindowMs that trigger the full attack response
    // Creation spam (e.g. a compromised/malicious bot rapidly creating
    // channels to post spam in). Two thresholds, checked independently:
    //  - burst: catches obvious bot behavior almost instantly. A human
    //    cannot create 3 channels through the UI in 5 seconds; a script can.
    //  - sustained: a slower-moving fallback matching the deletion thresholds,
    //    in case something creates channels just under the burst speed.
    creationBurst: { count: 3, windowMs: 5 * 1000 },
    channelCreates: 5,
    roleCreates: 5,
  },
  // How long an executor's ban/kick-granting roles are stripped after a
  // single unauthorized ban/kick with no audit log reason attached.
  quarantineDurationMs: 30 * 60 * 1000, // 30 minutes
  // Concurrency caps for restoration operations - see utils/RateLimiter.js.
  // Separate limiters per operation type so a burst of cleanup deletions
  // can't starve concurrent channel creation, and vice versa.
  rateLimits: {
    createConcurrency: 4,
    deleteConcurrency: 4,
    repairConcurrency: 8, // permission overwrites/positions are cheaper calls, safe to run more in parallel
    delayMs: 100,
  },
};

/**
 * Validates required configuration at startup so a missing token/owner ID
 * fails immediately with a clear message, rather than surfacing later as a
 * confusing runtime exception (e.g. discord.js rejecting an undefined token,
 * or every !save/!whitelist call silently failing the owner check because
 * ownerId is undefined and can never match a real user ID).
 *
 * Called once from index.js before the client is created.
 */
function validate() {
  const errors = [];

  if (!config.token || typeof config.token !== 'string' || config.token.trim() === '') {
    errors.push('DISCORD_TOKEN is missing. Set it in your .env file.');
  }

  if (!config.ownerId || typeof config.ownerId !== 'string' || config.ownerId.trim() === '') {
    errors.push('OWNER_ID is missing. Set it in your .env file to your Discord user ID.');
  } else if (!/^\d{17,20}$/.test(config.ownerId)) {
    errors.push(
      `OWNER_ID ("${config.ownerId}") doesn't look like a valid Discord snowflake ID (expected 17-20 digits).`
    );
  }

  if (!config.prefix || typeof config.prefix !== 'string') {
    errors.push('PREFIX must be a non-empty string.');
  }

  if (errors.length > 0) {
    console.error('\n[Config] Startup validation failed:\n');
    for (const err of errors) console.error(`  - ${err}`);
    console.error('\nFix the above in your .env file and restart the bot.\n');
    process.exit(1);
  }
}

module.exports = { ...config, validate };
