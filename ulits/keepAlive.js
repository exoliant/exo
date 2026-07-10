const http = require('http');
const https = require('https');
const config = require('../config');

// 10 minutes - chosen to comfortably clear Render's free-tier idle window
// (15 minutes, the shortest known threshold across supported hosts), while
// still being far more frequent than needed for Koyeb's 1-hour window. A
// shorter interval than strictly necessary is harmless (just extra pings);
// too long is the failure mode that actually matters, so this errs short.
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Starts a minimal HTTP server plus a periodic self-ping. This exists
 * purely to stop free hosting platforms (Replit, some Render/Railway free
 * tiers, etc.) from marking the process idle and spinning it down when
 * there's no incoming HTTP traffic - it has nothing to do with the bot's
 * anti-nuke logic. Kept in its own file, called once from index.js, so
 * it's trivial to remove entirely if you move to a host that doesn't need
 * it (a VPS, an always-on plan, systemd, pm2, etc.).
 *
 * Two layers, but they are NOT equally reliable:
 *  - An HTTP server that responds 200 to anything, meant to be pinged by
 *    an EXTERNAL uptime monitor (UptimeRobot, cron-job.org, etc.). This is
 *    the mechanism actually worth depending on - a request from a real
 *    external service has to go through the host's real public edge, so it
 *    can't be silently short-circuited the way a self-ping can.
 *  - An internal timer that self-pings that same server every 10 minutes.
 *    This is a bonus, not a guarantee: whether a self-ping counts as
 *    "public traffic" depends on how the host's internal DNS resolves the
 *    app's own public domain from inside its own container, which this
 *    code has no way to verify or control. Some platforms route that
 *    lookup internally (bypassing the edge entirely), in which case this
 *    self-ping "succeeds" but does nothing to prevent idle spin-down, with
 *    no visible error. See README "Keep-alive" section before assuming
 *    this alone is sufficient - set up an external monitor too.
 */
function startKeepAlive() {
  const port = config.port;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Anti-nuke bot is alive.\n');
  });

  server.on('error', (err) => {
    console.error('[KeepAlive] HTTP server error:', err);
  });

  server.listen(port, () => {
    console.log(`[KeepAlive] HTTP server listening on port ${port}`);
    if (!config.keepAliveUrl) {
      console.warn(
        '[KeepAlive] No public URL configured (KEEP_ALIVE_URL / KOYEB_PUBLIC_DOMAIN not set). ' +
          'The internal self-ping will only reach 127.0.0.1, which does NOT count as traffic on ' +
          'hosts like Koyeb that watch for inbound internet traffic specifically - it will not ' +
          'prevent idle spin-down there. Set KEEP_ALIVE_URL to your public URL if your host needs it.'
      );
    }
  });

  setInterval(() => pingSelf(port), HEARTBEAT_INTERVAL_MS).unref();

  return server;
}

/**
 * Pings config.keepAliveUrl if set (needed on hosts where the server is
 * only reachable via its public URL, not localhost - e.g. Replit), or
 * falls back to pinging the local server directly. Never throws - a
 * failed ping is logged and otherwise ignored, since it must not be able
 * to affect the bot's actual Discord-side operation.
 */
function pingSelf(port) {
  const target = config.keepAliveUrl || `http://127.0.0.1:${port}/`;
  const client = target.startsWith('https') ? https : http;

  const req = client.get(target, (res) => {
    console.log(`[KeepAlive] Heartbeat ping to ${target} -> ${res.statusCode}`);
    res.resume(); // drain so the socket closes cleanly
  });

  req.on('error', (err) => {
    console.error('[KeepAlive] Heartbeat ping failed:', err.message);
  });

  req.setTimeout(10000, () => req.destroy());
}

module.exports = { startKeepAlive };
