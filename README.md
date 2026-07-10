# Anti-Nuke Bot

A blueprint-based anti-nuke Discord bot. It saves a known-good snapshot of your
server's structure ("the blueprint") and continuously compares live changes
against it — restoring or reverting anything unauthorized, and banning
executors who trigger destructive-pattern thresholds.

## How it works, in one paragraph

You run `!save` once to capture the server's current state (roles, categories,
channels, permission overwrites, and a subset of server-wide settings) as the
blueprint. From then on, every relevant Discord event is attributed to an
executor via the audit log, checked against a per-user whitelist and the
executor's role rank relative to the bot, and then either: written into the
blueprint (if the change was authorized), reverted/restored (if not, and
non-destructive), or run through accident-vs-attack detection and
possibly banned + fully restored (if destructive).

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a `.env` file in the project root

```env
DISCORD_TOKEN=your-bot-token-here
OWNER_ID=your-discord-user-id-here
PREFIX=!
```

- `DISCORD_TOKEN` — from the [Discord Developer Portal](https://discord.com/developers/applications), your application's Bot tab.
- `OWNER_ID` — your own Discord user ID (enable Developer Mode in Discord, then right-click your name → Copy User ID). Only this user can run `!save` and `!whitelist`.
- `PREFIX` — optional, defaults to `!`.

The bot validates these at startup and will refuse to start with a clear error
message if `DISCORD_TOKEN` or `OWNER_ID` is missing or malformed — see
"Configuration validation" below.

### 3. Enable required intents (Discord Developer Portal)

In your application's **Bot** tab, under **Privileged Gateway Intents**, enable:

- **Server Members Intent** — required to fetch members for rank checks and to ban executors.
- **Message Content Intent** — required to read `!save`/`!whitelist` command text.

Also enable **Guild Moderation** under normal Gateway Intents (not privileged) — required to receive ban events (`guildBanAdd`).

The bot will fail to log in if these are required by its code but not enabled
for the application.

### 4. Invite the bot with sufficient permissions

The bot needs, at minimum:

- Manage Roles
- Manage Channels
- Ban Members (used both to ban malicious executors and to unban targets of a mass-ban attack)
- Kick Members
- View Audit Log

In practice, **Administrator** is the simplest way to guarantee the bot can
always act — a partial permission set can leave it able to *detect* an attack
but unable to *restore* or *ban*, which defeats the purpose.

Also make sure the bot's own role is positioned **above** any role you want it
to be able to moderate. Anyone whose highest role outranks the bot is treated
as an admin the bot can't (and shouldn't) fight — their changes get written
into the blueprint instead of reverted.

### 5. Run it

```bash
npm start
```

---

## The blueprint (`!save`)

**No protection is active until this has been run at least once.** Every
enforcement path in the bot — deletion restoration, config reversion, ban/kick
quarantine, and mass-attack response — checks for an existing blueprint
before doing anything, and simply does nothing if one doesn't exist yet. This
is intentional: without a saved baseline there's no "known-good state" to
enforce, and acting anyway (e.g. banning someone for deleting channels on a
server that never opted in) would be unaccountable and surprising.

Run `!save` in your server (owner-only) to capture the current state as the
new baseline:

```
!save
```

This records:

- Roles (name, color, hoist, mentionable, permissions, position, unicode emoji)
- Categories and channels (name, topic, NSFW, slowmode, bitrate/user limit,
  parent relationships, position)
- Permission overwrites for every category and channel
- A subset of server-wide settings (name, verification level, explicit
  content filter, default notifications, system/AFK channel, AFK timeout)

Run `!save` again any time you intentionally reorganize the server and want
the new layout treated as correct going forward — it fully overwrites the
previous blueprint.

You should also expect the blueprint to be **regenerated automatically**
after the bot completes a full attack-mode restoration, so IDs stay in sync
without manual re-saving.

---

## The whitelist (`!whitelist`)

Owner-only, per-guild, per-action, per-resource. Whitelisting is deliberately
**not** an all-or-nothing bypass — a whitelisted user is only exempt from the
specific actions (and optionally, specific resources) they've been granted.

```
!whitelist grant @user deleteChannel                 -> can delete ANY channel
!whitelist grant @user deleteCategory 112233445566   -> can delete only that one category
!whitelist grant @user banMember                      -> can ban anyone
!whitelist grant @user kickMember 998877665544        -> can kick only that one user
!whitelist revoke @user deleteRole                   -> removes that permission entirely
!whitelist revoke @user deleteRole 998877665544       -> removes just that one role ID from the allowed list
!whitelist remove @user                               -> removes the user from the whitelist entirely
!whitelist list @user                                 -> shows their current permissions
```

Rules:

- No entry for a permission at all → not allowed.
- Permission present with an empty list (`[]`) → allowed on any resource.
- Permission present with specific IDs → allowed only on those resources.

Whitelisted actions still get written into the blueprint when performed, so
the "correct state" of the server stays in sync with intentional changes.
Ban/kick are the exception — there's no "blueprint" for who's banned, so a
whitelisted ban/kick is simply left alone rather than recorded anywhere.

---

## Ban & kick protection

Mass-banning and mass-kicking are among the most common nuke tactics, and
they're handled with a **different policy than deletions** — banning one
person is routine moderation, not damage, so a single unauthorized ban/kick
is never auto-reverted the way an accidentally-deleted channel is.

For any ban/kick by someone not whitelisted for it (and who doesn't outrank
the bot):

| Situation | Response |
|---|---|
| Has an audit log reason attached | Allowed through, no punishment (still counted toward the threshold below) |
| No reason attached | The executor's ban/kick-granting roles are **temporarily stripped** (default 30 minutes, `quarantineDurationMs` in `config.js`) — a proportionate response short of a full ban |
| 3 or more bans/kicks (combined) from the same executor within 3 minutes | **Malicious**: executor is banned, further events from them are ignored, and the bot attempts to unban anyone they banned in that window |

Bans and kicks share **one combined counter** per executor, so an attacker
can't stay under the threshold by mixing 2 bans and 2 kicks.

### Known limitations specific to this feature

- **Kicked members cannot be automatically restored.** Discord has no API
  to force a former member back into a server — the bot can stop the
  attack (ban the executor) but not undo kicks that already happened. This
  is a hard platform limitation, not a gap in the bot's logic.
- **The guild owner can never be quarantined or banned** — Discord doesn't
  allow it via the API, regardless of the bot's permissions.
- **If ban/kick permission comes from an Administrator role**, quarantining
  removes that entire role (and everything else it grants), since Discord
  has no way to strip a single guild-wide permission from one member
  without touching the role(s) that grant it.
- **Quarantine survives a restart.** Pending quarantines are persisted to
  `data/cache/quarantine.json` and resumed on startup (see `ready.js`), so
  a crash mid-quarantine won't accidentally leave someone's roles stripped
  forever — or restore them early.

---

## Alert log channel (`!log`)

```
!log {channel_id}
!log #mod-logs
```

Posts a message to that channel whenever the bot takes a significant
enforcement action: a malicious deletion pattern, a malicious mass ban/kick,
or a temporary ban/kick-permission quarantine. Routine accidents (a single
restored channel) and permitted whitelisted actions are not logged, to keep
the channel focused on things that actually need attention.

- **Restricted to the server's own owner** (`guild.ownerId`) — deliberately
  different from `!save`/`!whitelist`, which are restricted to the single
  global bot owner (`OWNER_ID` in `.env`). Log channel configuration is a
  per-server preference, so each server's owner controls their own.
- **Only one log channel per server.** Running `!log` again replaces the
  previous one.
- **Self-healing.** If the log channel is ever deleted, the bot
  automatically recreates it (reusing the same name) the next time it needs
  to post an alert — no error, no manual re-running of `!log`. If a channel
  with the same name already exists (e.g. it was recreated separately by
  the blueprint-restore system because it was also part of your saved
  blueprint), the bot adopts that existing channel instead of creating a
  duplicate.
- If no log channel has ever been set, alerts are silently skipped — this
  is optional, not required for the bot's protection to work.

---

## Creation-spam protection (bots creating channels rapidly)

Unauthorized channel/role creation used to only ever get quietly deleted,
with no threshold or ban logic — meaning a fast-moving malicious bot could
keep creating channels indefinitely without consequence. Two thresholds now
apply (`config.thresholds`):

- **Burst**: 3+ creations within 5 seconds → banned almost immediately. A
  human cannot create 3 channels through the Discord UI that fast; a script
  can. This is the fast path for stopping an obviously automated actor.
- **Sustained**: 5+ creations within the normal 3-minute window (same shape
  as the deletion thresholds) → catches spam just under burst speed.

The ban is issued and awaited **before** the triggering channel/role is
cleaned up — stopping the executor from creating or posting more takes
priority over tidying up what's already there.

## Restoration speed (rate limiting)

Restoration operations (creating roles/categories/channels, applying
permission overwrites, setting positions, deleting unauthorized extras) run
**concurrently** rather than one at a time, bounded by three separate
semaphore-style limiters in `utils/RateLimiter.js` / `utils/rateLimiters.js`:

- `createLimiter` — role/category/channel creation
- `deleteLimiter` — cleanup deletions
- `repairLimiter` — permission overwrites and position updates

Separate limiters mean a burst of cleanup deletions can't starve concurrent
channel creation, and vice versa. Tune concurrency and pacing in
`config.rateLimits` (`createConcurrency`, `deleteConcurrency`,
`repairConcurrency`, `delayMs`) if you observe real 429s during large
restores on your server — the defaults are conservative starting points, not
measured against Discord's actual per-route limits. Note this is
**additional** protection on top of discord.js's own built-in rate-limit
queueing, not a replacement for it.

---

## Keep-alive (for free hosting)

Some free hosting platforms (Replit, some Render/Railway free tiers, Koyeb's
free instance, etc.) spin a process down after a period with no *inbound*
HTTP traffic. `utils/keepAlive.js` runs a minimal HTTP server (no extra
dependency - just Node's built-in `http` module) that responds `200` to
anything, plus an internal timer that pings it every 10 minutes as a backup.

- **Enabled by default.** Set `KEEP_ALIVE=false` in `.env` to disable it
  entirely (e.g. on always-on hosting where it's unnecessary).
- **`PORT`** — defaults to `3000`; most PaaS hosts inject their own `PORT`
  env var automatically, which this respects.
- **`KEEP_ALIVE_URL`** — set this to your bot's actual public URL so the
  internal self-ping reaches your host's edge/proxy and counts as real
  traffic. Pinging `127.0.0.1` (the fallback with nothing else configured)
  never leaves the process, so on hosts that specifically track *inbound
  internet* traffic (Koyeb, for example) it does **nothing** to prevent
  idle spin-down.

### ⚠️ Don't rely on the internal self-ping alone

The internal self-ping's reliability depends on something this bot **cannot
verify or control**: whether the host's internal DNS resolves the app's own
public domain out through the real edge network, or short-circuits it to an
internal/mesh route. If a platform does the latter, a self-ping silently
stops counting as public traffic and the app sleeps anyway — with no error,
since the request still "succeeds," it just never left the internal network.
This isn't hypothetical; it's a known pattern on some container platforms,
and there's no way to confirm Koyeb's exact behavior for your specific
deployment from the application code alone.

**The reliable fix is external, not internal:** point a free third-party
uptime monitor — [UptimeRobot](https://uptimerobot.com) or
[cron-job.org](https://cron-job.org) — at your bot's public URL, pinging
every 5-10 minutes. A request originating from an actual external service
cannot be internally short-circuited the way a self-ping can; it has to
enter through the real public edge. Treat this as the mechanism you're
actually depending on, and the internal 35-minute self-ping as a bonus, not
the reverse.

**Alternative**: if you bind a custom domain to your Koyeb app (rather than
using the auto-assigned `.koyeb.app` one), set `KEEP_ALIVE_URL` to that
custom domain. Custom domains are far less likely to have special internal
routing behavior than the platform's own generated subdomain, since they're
just ordinary DNS records pointing at Koyeb's edge.

### Koyeb specifics

The free tier can only be deployed as a "Web Service" (not a "Worker"), and
every Web Service automatically gets a public `https://<app>-<org>.koyeb.app`
URL — find it under your service's Overview/Domains tab in the Koyeb control
panel. Koyeb also injects it at runtime as `KOYEB_PUBLIC_DOMAIN`, which this
bot picks up automatically if `KEEP_ALIVE_URL` isn't set. Koyeb's free
instance scale-to-zero triggers after exactly 1 hour of no inbound traffic
and can't be disabled or customized on that tier. An open outbound
connection (like the bot's Discord gateway connection) does **not** count as
traffic on Koyeb — only inbound requests to the service do.

### Render specifics

Render's free web service spins down after just **15 minutes** of no inbound
traffic — much shorter than Koyeb's 1 hour, which is why the internal ping
runs every 10 minutes rather than 35. Render also auto-injects the service's
public URL as `RENDER_EXTERNAL_URL`, which this bot picks up automatically
if `KEEP_ALIVE_URL` isn't set. Render's own community support is more openly
skeptical of self-ping workarounds than Koyeb's docs are, describing them as
*"not a reliable or supported fix"* — treat the external uptime monitor
(UptimeRobot/cron-job.org) as doing the real work here even more so than on
other hosts.

**⚠️ More importantly: Render's free tier has an ephemeral filesystem.**
Render's own docs state that changes to a free web service's filesystem are
lost on every redeploy, restart, *and* spin-down/wake cycle. This bot stores
everything it needs — blueprints, whitelists, the log channel setting,
quarantine state — as local JSON files under `data/`. On Render free tier,
**all of that is wiped on every restart**, not just occasionally. In
practice this means:
- You'll need to re-run `!save` after essentially every deploy or restart.
- `!whitelist` and `!log` settings will also need to be reconfigured.
- If the bot restarts mid-restoration or mid-quarantine, that in-progress
  state is lost too (the crash-recovery logic in `ready.js` can't recover
  data that no longer exists on disk).

This is a platform limitation, not something fixable from inside the
application — the only real fixes are a persistent disk (a paid Render
feature) or moving blueprint/whitelist/settings storage to an external
service that persists independently of the container (a database, a hosted
key-value store, etc.), which is a larger change than the keep-alive
mechanism itself. If you're deploying on Render's free tier, budget for
re-establishing your configuration after restarts as a routine, not an edge
case.

This is pure infrastructure plumbing, unrelated to the bot's anti-nuke
logic — safe to ignore if you're on a host that doesn't need it.

---

## What gets protected, and how

| Event | Authorized | Unauthorized (destructive) | Unauthorized (non-destructive) |
|---|---|---|---|
| Channel/category/role **delete** | Blueprint updated | Accident (1 in 3 min) → silently restored. Attack (5+ in 3 min, or a category with 2+ channels) → executor banned, full server resync | — |
| Channel/category/role **create** | Blueprint updated | — | Object deleted immediately |
| Channel/category/role **update** | Blueprint updated | — | Reverted to blueprint's saved values |
| Server-wide settings **update** | Blueprint updated | — | Reverted to blueprint's saved values |

Executors who outrank the bot (highest role above the bot's highest role) are
never fought — their changes are always written into the blueprint, since the
bot has no reliable way to moderate them anyway.

---

## Known limitations

- **Server icons, banners, and splash images are not restorable.** The
  blueprint stores their hash (enough to *detect* that they changed) but not
  the underlying image bytes, so an unauthorized icon change will be logged
  as a deviation but not automatically reverted. Restoring these would
  require a separate asset-storage system (saving the actual image files
  alongside the JSON blueprint) — a reasonable future enhancement, not
  currently implemented.
- **Custom role icons** have the same limitation as server icons, for the
  same reason (hash-only storage).
- **Position restoration** uses Discord's batch position-set APIs, which have
  known quirks around large simultaneous reorders. Works for typical
  scenarios; may need tuning if you see partial reordering on very large
  servers.
- **Slash commands are not implemented.** All commands are prefix-based
  (`!save`, `!whitelist`). `interactionCreate.js` exists as a placeholder for
  future slash-command support but currently just replies that they aren't
  supported yet.
- **A blueprint must exist before protection is meaningful.** Run `!save`
  immediately after inviting the bot to a server you want protected.

---

## Configuration validation

On startup, `config.validate()` checks that `DISCORD_TOKEN` and `OWNER_ID` are
present and that `OWNER_ID` looks like a real Discord snowflake (17-20
digits). If validation fails, the bot prints a clear list of what's wrong and
exits immediately, rather than failing later with a confusing discord.js
login error or silently rejecting every owner-only command because
`OWNER_ID` was `undefined`.

---

## Project structure

```
anti-nuke-bot/
├── index.js              # Bootstrap only: config, client, loaders, login
├── config.js             # Env vars, thresholds, startup validation
├── commands/             # Prefix commands (!save, !whitelist)
├── events/               # Thin discord.js event handlers -> PolicyManager
├── managers/
│   ├── AuditManager.js       # Who did it, what, when (audit log resolution)
│   ├── WhitelistManager.js   # Granular per-action/per-resource permissions
│   ├── BlueprintManager.js   # Save/load/diff/update the source-of-truth JSON
│   ├── PolicyManager.js      # "Is this executor allowed to make this change?"
│   ├── DetectionManager.js   # Accident vs. malicious pattern analysis
│   └── RestoreManager.js     # All server mutation: restore, revert, cleanup
├── repair/cleanupUnknown.js  # Deletes unauthorized "extra" objects (attack path only)
├── utils/                    # constants, field-comparison, directory setup
└── data/                     # blueprints/, whitelist/, cache/, logs/ (auto-created)
```
