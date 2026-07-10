const fs = require('fs');
const path = require('path');
const { ChannelType, AuditLogEvent, PermissionFlagsBits } = require('discord.js');

const BlueprintManager = require('./BlueprintManager');
const cleanupUnknown = require('../repair/cleanupUnknown');
const config = require('../config');
const { createLimiter, deleteLimiter, repairLimiter } = require('../utils/rateLimiters');

const LOCK_DIR = path.join(__dirname, '..', 'temp');
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const QUARANTINE_FILE = path.join(CACHE_DIR, 'quarantine.json');
const EXECUTOR_IGNORE_TTL_MS = 60 * 1000; // safety net in case ban is delayed/fails
const TARGET_IGNORE_TTL_MS = 30 * 1000; // safety net for ref-counted self-suppression

if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true });
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

/**
 * RestoreManager is the sole owner of restoration state and the only manager
 * that mutates the live server on the bot's behalf. Every other manager
 * treats it as a black box: "restore this" or "restore everything" in,
 * server state out. Nothing outside this file should know about lock files,
 * remap tables, or restoration ordering.
 */
class RestoreManager {
  constructor() {
    this.restoringGuilds = new Set(); // guildId
    this.repairQueues = new Map(); // guildId -> [{ type, targetId, enqueuedAt }]

    // guildId -> Map(executorId -> expiresAt)
    this.ignoredExecutors = new Map();

    // targetId -> { count, expires } - reference counted, see markIgnoredTarget
    this.ignoredTargets = new Map();

    // `${guildId}:${userId}` -> { guildId, userId, roleIds, expiresAt, reason }
    this.quarantines = new Map();
    this._loadQuarantines();

    setInterval(() => this._cleanup(), 30 * 1000).unref();
  }

  // ---------------------------------------------------------------------
  // Restoration state
  // ---------------------------------------------------------------------

  isRestoring(guildId) {
    return this.restoringGuilds.has(guildId);
  }

  _lockPath(guildId) {
    return path.join(LOCK_DIR, `restoring-${guildId}.lock`);
  }

  _beginRestoring(guildId, reason) {
    this.restoringGuilds.add(guildId);
    try {
      fs.writeFileSync(
        this._lockPath(guildId),
        JSON.stringify({ startedAt: Date.now(), reason }, null, 2),
        'utf8'
      );
    } catch (err) {
      // Lock file is for crash recovery/debugging only - the in-memory flag
      // is authoritative for runtime behavior, so a write failure here
      // shouldn't block restoration.
      console.error(`[RestoreManager] Failed to write lock file for ${guildId}:`, err);
    }
  }

  _endRestoring(guildId) {
    this.restoringGuilds.delete(guildId);
    try {
      fs.unlinkSync(this._lockPath(guildId));
    } catch {
      // Fine if it never got created or was already removed.
    }
  }

  // ---------------------------------------------------------------------
  // Executor ignore (post-ban safety net)
  // ---------------------------------------------------------------------

  isIgnoredExecutor(guildId, executorId) {
    const map = this.ignoredExecutors.get(guildId);
    if (!map) return false;
    const expiry = map.get(executorId);
    if (!expiry) return false;
    if (expiry <= Date.now()) {
      map.delete(executorId);
      return false;
    }
    return true;
  }

  markIgnoredExecutor(guildId, executorId, ttlMs = EXECUTOR_IGNORE_TTL_MS) {
    if (!this.ignoredExecutors.has(guildId)) this.ignoredExecutors.set(guildId, new Map());
    this.ignoredExecutors.get(guildId).set(executorId, Date.now() + ttlMs);
  }

  clearIgnoredExecutor(guildId, executorId) {
    this.ignoredExecutors.get(guildId)?.delete(executorId);
  }

  // ---------------------------------------------------------------------
  // Target ignore (reference counted) - suppresses reactions to the bot's
  // own create/update operations during restoration. Every internal
  // mutating call increments the count before acting; the corresponding
  // gateway event handler (once create/update detectors exist) decrements
  // it. A TTL is kept as a safety net so a missed decrement can't leak
  // permanently.
  //
  // TODO: Integrate ignore reference counting with create/update event
  // handlers (channelCreate, roleCreate, channelUpdate, roleUpdate) once
  // those detectors exist, so counts are decremented on the actual
  // corresponding gateway event rather than relying solely on the TTL.
  // ---------------------------------------------------------------------

  isIgnoredTarget(targetId) {
    const entry = this.ignoredTargets.get(targetId);
    if (!entry) return false;
    if (entry.expires <= Date.now()) {
      this.ignoredTargets.delete(targetId);
      return false;
    }
    return entry.count > 0;
  }

  markIgnoredTarget(targetId, ttlMs = TARGET_IGNORE_TTL_MS) {
    let entry = this.ignoredTargets.get(targetId);
    if (!entry) {
      entry = { count: 0, expires: 0 };
      this.ignoredTargets.set(targetId, entry);
    }
    entry.count += 1;
    entry.expires = Date.now() + ttlMs;
  }

  clearIgnoredTarget(targetId) {
    const entry = this.ignoredTargets.get(targetId);
    if (!entry) return;
    entry.count = Math.max(0, entry.count - 1);
    if (entry.count === 0) this.ignoredTargets.delete(targetId);
  }

  // ---------------------------------------------------------------------
  // Quarantine - temporarily strips ban/kick-granting roles from an
  // executor who performed an unauthorized ban/kick with no audit log
  // reason. This is a proportionate response distinct from a full ban:
  // it removes their ability to repeat the action, not their server
  // membership. Persisted to disk so a bot restart doesn't accidentally
  // strip someone's roles permanently if the process dies mid-quarantine.
  // ---------------------------------------------------------------------

  _quarantineKey(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  _loadQuarantines() {
    if (!fs.existsSync(QUARANTINE_FILE)) return;
    try {
      const raw = fs.readFileSync(QUARANTINE_FILE, 'utf8');
      const records = raw.trim().length ? JSON.parse(raw) : [];
      for (const record of records) {
        this.quarantines.set(this._quarantineKey(record.guildId, record.userId), record);
      }
    } catch (err) {
      console.error('[RestoreManager] Failed to load persisted quarantine records:', err);
    }
  }

  _persistQuarantines() {
    try {
      const records = [...this.quarantines.values()];
      const tmpPath = `${QUARANTINE_FILE}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2), 'utf8');
      fs.renameSync(tmpPath, QUARANTINE_FILE);
    } catch (err) {
      console.error('[RestoreManager] Failed to persist quarantine records:', err);
    }
  }

  /**
   * Strips whichever of the member's current roles grant BanMembers or
   * KickMembers, and schedules their return after config.quarantineDurationMs.
   *
   * Known limitation: if the permission comes from an Administrator role
   * (which implies every permission, not just ban/kick), removing that role
   * strips everything it grants, not just ban/kick - Discord has no way to
   * selectively revoke a single guild-wide permission from one member
   * without touching the role(s) that grant it. Similarly, the guild owner
   * and any role positioned above the bot can't be touched at all.
   *
   * @param {import('discord.js').Guild} guild
   * @param {import('discord.js').GuildMember} member
   * @param {string} reason
   */
  async quarantinePermissions(guild, member, reason) {
    if (guild.ownerId === member.id) {
      console.warn(`[RestoreManager] Cannot quarantine ${member.id} - they are the guild owner.`);
      return;
    }

    const botMember = guild.members.me;
    const rolesToStrip = member.roles.cache.filter((role) => {
      if (role.id === guild.id) return false; // @everyone can't be removed from a member
      if (botMember && role.position >= botMember.roles.highest.position) return false; // can't touch
      return (
        role.permissions.has(PermissionFlagsBits.BanMembers) ||
        role.permissions.has(PermissionFlagsBits.KickMembers) ||
        role.permissions.has(PermissionFlagsBits.Administrator)
      );
    });

    if (rolesToStrip.size === 0) {
      console.warn(
        `[RestoreManager] Could not quarantine ${member.id} in ${guild.id} - no removable role grants ban/kick/admin.`
      );
      return;
    }

    const roleIds = [...rolesToStrip.keys()];

    try {
      await member.roles.remove(roleIds, reason);
    } catch (err) {
      console.error(`[RestoreManager] Failed to strip roles from ${member.id} in ${guild.id}:`, err);
      return;
    }

    const record = {
      guildId: guild.id,
      userId: member.id,
      roleIds,
      expiresAt: Date.now() + config.quarantineDurationMs,
      reason,
    };

    this.quarantines.set(this._quarantineKey(guild.id, member.id), record);
    this._persistQuarantines();

    console.warn(
      `[RestoreManager] Quarantined ${member.id} in ${guild.id} for ${config.quarantineDurationMs / 60000} minute(s): stripped ${roleIds.length} role(s).`
    );

    setTimeout(() => {
      this.restoreQuarantinedPermissions(guild.id, member.id).catch((err) =>
        console.error(`[RestoreManager] Scheduled quarantine restore failed for ${member.id}:`, err)
      );
    }, config.quarantineDurationMs).unref();
  }

  /**
   * Restores a previously quarantined member's roles. Called by the
   * scheduled timeout above, and also from ready.js at startup to resume
   * any quarantines that were still pending when the bot last shut down.
   *
   * @param {string} guildId
   * @param {string} userId
   * @param {import('discord.js').Guild} [guildOverride] - pass the live guild directly if already fetched (used during startup recovery)
   */
  async restoreQuarantinedPermissions(guildId, userId, guildOverride = null) {
    const key = this._quarantineKey(guildId, userId);
    const record = this.quarantines.get(key);
    if (!record) return;

    this.quarantines.delete(key);
    this._persistQuarantines();

    const guild = guildOverride;
    if (!guild) {
      console.warn(`[RestoreManager] No live guild reference to restore quarantine for ${userId}; record cleared.`);
      return;
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return; // they left/were removed - nothing to restore

    try {
      await member.roles.add(record.roleIds, 'Anti-nuke: restoring temporarily revoked ban/kick permissions');
      console.log(`[RestoreManager] Restored quarantined roles for ${userId} in ${guildId}.`);
    } catch (err) {
      console.error(`[RestoreManager] Failed to restore quarantined roles for ${userId} in ${guildId}:`, err);
    }
  }

  /**
   * Called once from ready.js at startup. Any quarantine record already
   * past its expiry gets restored immediately; anything still pending is
   * rescheduled for its remaining duration.
   */
  async resumeQuarantines(client) {
    for (const record of [...this.quarantines.values()]) {
      const guild = client.guilds.cache.get(record.guildId);
      if (!guild) continue;

      const remaining = record.expiresAt - Date.now();
      if (remaining <= 0) {
        await this.restoreQuarantinedPermissions(record.guildId, record.userId, guild);
      } else {
        setTimeout(() => {
          this.restoreQuarantinedPermissions(record.guildId, record.userId, guild).catch((err) =>
            console.error(`[RestoreManager] Resumed quarantine restore failed for ${record.userId}:`, err)
          );
        }, remaining).unref();
      }
    }
  }

  /**
   * Attack-response helper for mass ban/kick: unbans anyone the given
   * executor banned within the time window, determined by cross-referencing
   * current bans against MemberBanAdd audit log entries. Kicked members
   * cannot be restored this way - Discord has no API to force a former
   * member back into a guild.
   *
   * @param {import('discord.js').Guild} guild
   * @param {string} executorId
   * @param {number} sinceTimestamp
   * @returns {Promise<string[]>} user IDs successfully unbanned
   */
  async unbanRecentTargets(guild, executorId, sinceTimestamp) {
    let auditEntries;
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 50 });
      auditEntries = [...logs.entries.values()];
    } catch (err) {
      console.error(`[RestoreManager] Failed to fetch ban audit logs for ${guild.id}:`, err);
      return [];
    }

    const targetIds = auditEntries
      .filter((entry) => entry.executorId === executorId && entry.createdTimestamp >= sinceTimestamp)
      .map((entry) => entry.target?.id)
      .filter(Boolean);

    const unbanned = [];
    for (const userId of targetIds) {
      try {
        await guild.members.unban(userId, 'Anti-nuke: reversing mass ban attack');
        unbanned.push(userId);
      } catch (err) {
        console.error(`[RestoreManager] Failed to unban ${userId} in ${guild.id}:`, err);
      }
    }

    return unbanned;
  }

  // ---------------------------------------------------------------------
  // Repair queue - for deletion events that arrive while a full restore
  // is already in progress.
  // ---------------------------------------------------------------------

  enqueueRepairCheck(guild, type, targetId) {
    if (!this.repairQueues.has(guild.id)) this.repairQueues.set(guild.id, []);
    this.repairQueues.get(guild.id).push({ type, targetId, enqueuedAt: Date.now() });
  }

  /**
   * After a full restore finishes, re-diff and recreate anything still
   * missing. This naturally covers stragglers queued mid-restore without
   * needing to track specific old IDs - if the blueprint says it should
   * exist and it doesn't, it gets recreated; if it already exists
   * (because the main pass caught it), the diff simply won't list it.
   */
  async _drainRepairQueue(guild) {
    const queue = this.repairQueues.get(guild.id) || [];
    this.repairQueues.delete(guild.id);
    if (queue.length === 0) return;

    const diff = BlueprintManager.diff(guild);
    if (!diff) return;

    const hasMissing =
      diff.missingRoles.length || diff.missingCategories.length || diff.missingChannels.length;

    if (hasMissing) {
      console.warn(
        `[RestoreManager] Repair queue found ${queue.length} straggler event(s) in ${guild.id}; running a follow-up restore pass.`
      );
      await this._restoreMissing(guild, diff);
    }
  }

  // ---------------------------------------------------------------------
  // Accident path: restore exactly one object
  // ---------------------------------------------------------------------

  /**
   * Restores a single deleted object from the blueprint. Used for the
   * accident path only - never touches unrelated "extra" objects.
   *
   * Unlike the full restore, this assumes the rest of the server is
   * intact: any category or role the object depends on still exists
   * under its original ID, so no remap table is needed - an identity
   * mapping (empty Map, falling back to the original ID) is correct.
   *
   * @param {import('discord.js').Guild} guild
   * @param {'role'|'category'|'channel'} type
   * @param {string} targetId - the OLD id of the deleted object (as saved in the blueprint)
   */
  async restoreSingle(guild, type, targetId) {
    if (this.isRestoring(guild.id)) {
      this.enqueueRepairCheck(guild, type, targetId);
      return;
    }

    const blueprint = BlueprintManager.load(guild.id);
    if (!blueprint) return; // no baseline saved yet, nothing to restore against

    const listKey = type === 'role' ? 'roles' : type === 'category' ? 'categories' : 'channels';
    const entry = blueprint[listKey].find((e) => e.id === targetId);
    if (!entry) return; // wasn't part of the known-good state

    try {
      let created;

      if (type === 'role') {
        created = await createLimiter.run(() => this._createRole(guild, entry));
        await repairLimiter.run(() => this._restorePositionsSingle(guild, 'role', created.id, entry.position));
      } else if (type === 'category') {
        created = await createLimiter.run(() => this._createCategory(guild, entry));
        await repairLimiter.run(() => this._applyOverwrites(created, entry.permissionOverwrites, new Map()));
        await repairLimiter.run(() => this._restorePositionsSingle(guild, 'channel', created.id, entry.position));
      } else {
        // Identity mapping: the parent category still exists under its
        // original ID since only this one object was deleted.
        created = await createLimiter.run(() => this._createChannel(guild, entry, new Map()));
        await repairLimiter.run(() => this._applyOverwrites(created, entry.permissionOverwrites, new Map()));
        await repairLimiter.run(() => this._restorePositionsSingle(guild, 'channel', created.id, entry.position));
      }

      if (created) {
        BlueprintManager.remapId(guild.id, type, targetId, created.id);
      }
    } catch (err) {
      console.error(`[RestoreManager] restoreSingle failed for ${type} ${targetId} in ${guild.id}:`, err);
    }
  }

  // ---------------------------------------------------------------------
  // Policy-driven paths: unauthorized creations and updates (non-destructive
  // events). These are simpler than the delete paths - no accident/malicious
  // distinction, just "not allowed -> put it back the way the blueprint says".
  // ---------------------------------------------------------------------

  /**
   * Deletes an object that was created without authorization. Marks it
   * ignored first so the resulting delete event doesn't get mis-attributed
   * or trigger destructive-event analysis - PolicyManager checks
   * isIgnoredTarget before doing anything else.
   *
   * @param {import('discord.js').Guild} guild
   * @param {'role'|'category'|'channel'} kind
   * @param {string} targetId
   */
  async deleteUnauthorizedCreation(guild, kind, targetId) {
    this.markIgnoredTarget(targetId);

    try {
      const live = kind === 'role' ? guild.roles.cache.get(targetId) : guild.channels.cache.get(targetId);
      if (!live) {
        this.clearIgnoredTarget(targetId); // nothing to delete, no echo will arrive
        return;
      }
      await deleteLimiter.run(() => live.delete('Anti-nuke: unauthorized creation not permitted by policy'));
      // Leave the ignore mark in place - the echoed delete event clears it
      // (or the TTL safety net does, if that echo never arrives).
    } catch (err) {
      console.error(`[RestoreManager] Failed to delete unauthorized ${kind} ${targetId}:`, err);
      this.clearIgnoredTarget(targetId); // delete failed, no echo will arrive - don't leak the mark
    }
  }

  /**
   * Reverts an unauthorized update back to the blueprint's saved state for
   * a single channel/category/role. Assumes the object itself still
   * exists (this is an update, not a delete) - only its properties changed.
   *
   * @param {import('discord.js').Guild} guild
   * @param {'role'|'category'|'channel'} kind
   * @param {string} targetId
   */
  async revertChange(guild, kind, targetId) {
    const blueprint = BlueprintManager.load(guild.id);
    if (!blueprint) return;

    const listKey = kind === 'role' ? 'roles' : kind === 'category' ? 'categories' : 'channels';
    const entry = blueprint[listKey].find((e) => e.id === targetId);
    if (!entry) return; // not something we have a baseline for

    const live = kind === 'role' ? guild.roles.cache.get(targetId) : guild.channels.cache.get(targetId);
    if (!live) return;

    this.markIgnoredTarget(targetId);

    try {
      if (kind === 'role') {
        await repairLimiter.run(() =>
          live.edit({
            name: entry.name,
            color: entry.color,
            hoist: entry.hoist,
            mentionable: entry.mentionable,
            permissions: BigInt(entry.permissions),
            unicodeEmoji: entry.unicodeEmoji ?? null,
            // Custom role icon intentionally not restored here - iconHash is
            // stored for change detection only. Restoring it requires the
            // original image bytes, not just the hash. Same known limitation
            // as guild icons/banners; see RestoreManager.revertGuildSettings.
            reason: 'Anti-nuke: reverting unauthorized role change',
          })
        );
      } else {
        const editOptions = { name: entry.name, reason: 'Anti-nuke: reverting unauthorized change' };
        if (kind === 'channel') {
          if ('topic' in entry) editOptions.topic = entry.topic;
          if ('nsfw' in entry) editOptions.nsfw = entry.nsfw;
          if ('rateLimitPerUser' in entry) editOptions.rateLimitPerUser = entry.rateLimitPerUser;
          if ('bitrate' in entry && entry.bitrate) editOptions.bitrate = entry.bitrate;
          if ('userLimit' in entry && entry.userLimit) editOptions.userLimit = entry.userLimit;
          if ('parentId' in entry) editOptions.parent = entry.parentId || null;
        }
        await repairLimiter.run(() => live.edit(editOptions));
        await repairLimiter.run(() => this._applyOverwrites(live, entry.permissionOverwrites, new Map()));
      }

      await repairLimiter.run(() =>
        this._restorePositionsSingle(guild, kind === 'role' ? 'role' : 'channel', targetId, entry.position)
      );
    } catch (err) {
      console.error(`[RestoreManager] Failed to revert ${kind} ${targetId}:`, err);
    } finally {
      // Leave the mark for the echoed update event to clear; TTL backstops it.
    }
  }

  /**
   * Reverts unauthorized guild-level (server) setting changes back to the
   * blueprint's saved values.
   *
   * @param {import('discord.js').Guild} guild
   */
  async revertGuildSettings(guild) {
    const blueprint = BlueprintManager.load(guild.id);
    if (!blueprint || !blueprint.guild) return;

    this.markIgnoredTarget(guild.id);

    try {
      await guild.edit({
        name: blueprint.guild.name,
        verificationLevel: blueprint.guild.verificationLevel,
        explicitContentFilter: blueprint.guild.explicitContentFilter,
        defaultMessageNotifications: blueprint.guild.defaultMessageNotifications,
        systemChannelId: blueprint.guild.systemChannelId,
        afkChannelId: blueprint.guild.afkChannelId,
        afkTimeout: blueprint.guild.afkTimeout,
        reason: 'Anti-nuke: reverting unauthorized server settings change',
      });
      // Note: icon reversion is intentionally omitted here - it requires
      // re-uploading raw image bytes, not just a hash. Extend with
      // guild.iconURL()-fetch-and-reupload logic if icon protection is needed.
    } catch (err) {
      console.error(`[RestoreManager] Failed to revert guild settings for ${guild.id}:`, err);
    }
  }

  // ---------------------------------------------------------------------
  // Attack path: full server synchronization
  // ---------------------------------------------------------------------

  /**
   * Fully synchronizes the live server with the blueprint: recreates
   * everything missing, translates permission overwrites through a remap
   * table, restores positions, then deletes unauthorized extras. Finishes
   * by regenerating a fresh blueprint so IDs never need remapping again.
   *
   * @param {import('discord.js').Guild} guild
   * @param {string} [reason]
   */
  async restoreFull(guild, reason = 'attack-detected') {
    if (this.isRestoring(guild.id)) return; // already in progress, don't overlap

    const blueprint = BlueprintManager.load(guild.id);
    if (!blueprint) {
      console.warn(`[RestoreManager] No blueprint saved for ${guild.id}; cannot restore.`);
      return;
    }

    this._beginRestoring(guild.id, reason);

    try {
      const diff = BlueprintManager.diff(guild);
      await this._restoreMissing(guild, diff);

      // Re-diff for the cleanup phase - restoreMissing may have changed
      // what counts as "extra" (nothing should have, but this keeps the
      // cleanup phase working off current truth rather than a stale diff).
      const postRestoreDiff = BlueprintManager.diff(guild);
      const cleanupResult = await cleanupUnknown(guild, postRestoreDiff);
      console.log(`[RestoreManager] Cleanup result for ${guild.id}:`, cleanupResult);

      // Drain anything that was queued while we were working.
      await this._drainRepairQueue(guild);

      // Blueprint is now stale (new IDs, positions may have shifted) -
      // regenerate it fresh rather than trying to keep translating.
      await BlueprintManager.save(guild);
    } catch (err) {
      console.error(`[RestoreManager] restoreFull failed for ${guild.id}:`, err);
    } finally {
      this._endRestoring(guild.id);
    }
  }

  // ---------------------------------------------------------------------
  // Ordered restoration phases (roles -> categories -> channels -> perms -> positions)
  // ---------------------------------------------------------------------

  async _restoreMissing(guild, diff) {
    const roleRemap = new Map(); // oldId -> newId
    const categoryRemap = new Map();
    const channelRemap = new Map();

    // Phase 1: roles - created concurrently (bounded by createLimiter) rather
    // than one at a time. Each creation is independent, so this is a pure
    // speed win with no ordering risk.
    await Promise.all(
      diff.missingRoles.map(async (roleData) => {
        try {
          const created = await createLimiter.run(() => this._createRole(guild, roleData));
          roleRemap.set(roleData.id, created.id);
          BlueprintManager.remapId(guild.id, 'role', roleData.id, created.id);
        } catch (err) {
          console.error(`[RestoreManager] Failed to recreate role ${roleData.id}:`, err);
        }
      })
    );

    // Phase 2: categories (structure only; overwrites applied in phase 4).
    // Parallelized like roles - categories don't depend on each other.
    await Promise.all(
      diff.missingCategories.map(async (catData) => {
        try {
          const created = await createLimiter.run(() => this._createCategory(guild, catData));
          categoryRemap.set(catData.id, created.id);
          BlueprintManager.remapId(guild.id, 'category', catData.id, created.id);
        } catch (err) {
          console.error(`[RestoreManager] Failed to recreate category ${catData.id}:`, err);
        }
      })
    );

    // Phase 3: channels (parented via categoryRemap; overwrites in phase 4).
    // Runs after phase 2 completes so categoryRemap is fully populated before
    // any channel tries to resolve its parent - the one place inter-phase
    // ordering still matters. Channels among themselves are independent.
    await Promise.all(
      diff.missingChannels.map(async (chanData) => {
        try {
          const created = await createLimiter.run(() => this._createChannel(guild, chanData, categoryRemap));
          channelRemap.set(chanData.id, created.id);
          BlueprintManager.remapId(guild.id, 'channel', chanData.id, created.id);
        } catch (err) {
          console.error(`[RestoreManager] Failed to recreate channel ${chanData.id}:`, err);
        }
      })
    );

    // Phase 4: permission overwrites - now that every role/category/channel
    // exists, translate old IDs referenced in overwrites through the remap
    // tables and apply them. Re-apply for ALL blueprint categories/channels
    // (not just newly created ones), since a changed overwrite on an
    // existing object is also a deviation from the blueprint worth fixing
    // during a full sync. Parallelized with repairLimiter - overwrite calls
    // are independent per-object.
    const blueprint = BlueprintManager.load(guild.id);

    await Promise.all([
      ...blueprint.categories.map(async (catData) => {
        const liveId = categoryRemap.get(catData.id) || catData.id;
        const live = guild.channels.cache.get(liveId);
        if (live) await repairLimiter.run(() => this._applyOverwrites(live, catData.permissionOverwrites, roleRemap));
      }),
      ...blueprint.channels.map(async (chanData) => {
        const liveId = channelRemap.get(chanData.id) || chanData.id;
        const live = guild.channels.cache.get(liveId);
        if (live) await repairLimiter.run(() => this._applyOverwrites(live, chanData.permissionOverwrites, roleRemap));
      }),
    ]);

    // Phase 5: positions - only after everything exists and is parented correctly.
    await this._restorePositions(guild, roleRemap, categoryRemap, channelRemap);
  }

  // ---------------------------------------------------------------------
  // Object creation helpers
  // ---------------------------------------------------------------------

  /**
   * Restores position for a single recreated object (accident path).
   * Kept separate from the batch _restorePositions used in a full sync,
   * since there's no remap table to consult here.
   */
  async _restorePositionsSingle(guild, kind, liveId, position) {
    try {
      if (kind === 'role') {
        await guild.roles.setPositions([{ role: liveId, position }]);
      } else {
        await guild.channels.setPositions([{ channel: liveId, position }]);
      }
    } catch (err) {
      console.error(`[RestoreManager] Failed to restore position for ${liveId} in ${guild.id}:`, err);
    }
  }

  async _createRole(guild, roleData) {
    this.markIgnoredTarget(`pending-role-${roleData.name}`);
    try {
      return await guild.roles.create({
        name: roleData.name,
        color: roleData.color,
        hoist: roleData.hoist,
        mentionable: roleData.mentionable,
        permissions: BigInt(roleData.permissions),
        reason: 'Anti-nuke: restoring role from blueprint',
      });
    } finally {
      this.clearIgnoredTarget(`pending-role-${roleData.name}`);
    }
  }

  async _createCategory(guild, catData) {
    return guild.channels.create({
      name: catData.name,
      type: ChannelType.GuildCategory,
      reason: 'Anti-nuke: restoring category from blueprint',
    });
  }

  async _createChannel(guild, chanData, categoryRemap) {
    const parentId = chanData.parentId
      ? categoryRemap.get(chanData.parentId) || chanData.parentId
      : null;

    const options = {
      name: chanData.name,
      type: chanData.type,
      parent: parentId || undefined,
      reason: 'Anti-nuke: restoring channel from blueprint',
    };

    if ('topic' in chanData && chanData.topic) options.topic = chanData.topic;
    if ('nsfw' in chanData) options.nsfw = chanData.nsfw;
    if ('rateLimitPerUser' in chanData) options.rateLimitPerUser = chanData.rateLimitPerUser;
    if ('bitrate' in chanData && chanData.bitrate) options.bitrate = chanData.bitrate;
    if ('userLimit' in chanData && chanData.userLimit) options.userLimit = chanData.userLimit;

    return guild.channels.create(options);
  }

  /**
   * Translates and applies stored permission overwrites onto a live
   * channel/category. Role IDs are passed through the remap table; if an
   * overwrite references a role that no longer exists at all (deleted and
   * not part of this restore, e.g. manually removed on purpose), it's
   * skipped rather than throwing.
   */
  async _applyOverwrites(liveObject, overwritesData, roleRemap) {
    const translated = [];

    for (const ow of overwritesData) {
      let id = ow.id;

      if (ow.type === 0) {
        // role-type overwrite - translate through remap if this role was recreated
        id = roleRemap.get(ow.id) || ow.id;
        if (!liveObject.guild.roles.cache.has(id)) continue; // role truly gone, skip
      } else {
        // member-type overwrite - member IDs never change, but the member
        // may have left; Discord will just no-op/error harmlessly on unknown IDs
        // via a try/catch at the call site below.
      }

      translated.push({
        id,
        type: ow.type,
        allow: BigInt(ow.allow),
        deny: BigInt(ow.deny),
      });
    }

    try {
      await liveObject.permissionOverwrites.set(translated, 'Anti-nuke: restoring permission overwrites');
    } catch (err) {
      console.error(`[RestoreManager] Failed to apply overwrites on ${liveObject.id}:`, err);
    }
  }

  async _restorePositions(guild, roleRemap, categoryRemap, channelRemap) {
    const blueprint = BlueprintManager.load(guild.id);

    const rolePositions = blueprint.roles
      .map((r) => ({ role: roleRemap.get(r.id) || r.id, position: r.position }))
      .filter((r) => guild.roles.cache.has(r.role));

    if (rolePositions.length) {
      try {
        await repairLimiter.run(() => guild.roles.setPositions(rolePositions));
      } catch (err) {
        console.error(`[RestoreManager] Failed to restore role positions in ${guild.id}:`, err);
      }
    }

    const channelPositions = [
      ...blueprint.categories.map((c) => ({
        channel: categoryRemap.get(c.id) || c.id,
        position: c.position,
      })),
      ...blueprint.channels.map((c) => ({
        channel: channelRemap.get(c.id) || c.id,
        position: c.position,
      })),
    ].filter((c) => guild.channels.cache.has(c.channel));

    if (channelPositions.length) {
      try {
        await repairLimiter.run(() => guild.channels.setPositions(channelPositions));
      } catch (err) {
        console.error(`[RestoreManager] Failed to restore channel positions in ${guild.id}:`, err);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------

  _cleanup() {
    const now = Date.now();

    for (const [guildId, map] of this.ignoredExecutors) {
      for (const [executorId, expiry] of map) {
        if (expiry <= now) map.delete(executorId);
      }
      if (map.size === 0) this.ignoredExecutors.delete(guildId);
    }

    for (const [targetId, entry] of this.ignoredTargets) {
      if (entry.expires <= now) this.ignoredTargets.delete(targetId);
    }
  }
}

module.exports = new RestoreManager();
