const RestoreManager = require('./RestoreManager');
const LogManager = require('./LogManager');
const config = require('../config');

const COUNTER_WINDOW_MS = config.accidentWindowMs; // 3 minutes

/**
 * DetectionManager's sole responsibility: given an already-attributed,
 * already-policy-cleared destructive event (PolicyManager has confirmed
 * the executor is not whitelisted and does not outrank the bot), decide
 * whether it's an accident or a malicious pattern, and act accordingly.
 *
 * It knows nothing about who is allowed to do what (PolicyManager), how
 * executors are attributed (AuditManager), or how repair actually happens
 * beyond calling RestoreManager. This keeps "is this malicious?" as one
 * clean, testable decision.
 */
class DetectionManager {
  constructor() {
    // executorId -> { channelDeletes: number[], roleDeletes: number[], categoryDeletes: number[] }
    this.executorCounters = new Map();

    setInterval(() => this._cleanup(), 30 * 1000).unref();
  }

  /**
   * @param {import('discord.js').Guild} guild
   * @param {'channel'|'category'|'role'} kind
   * @param {string} targetId
   * @param {string} executorId
   * @param {Object} [extra]
   * @param {number} [extra.childChannelCount] - for categories, how many channels it contained
   */
  async handleDestructiveEvent(guild, kind, targetId, executorId, extra = {}) {
    const counterName = `${kind}Deletes`; // channelDeletes | categoryDeletes | roleDeletes

    this._recordAction(executorId, counterName);
    const recentCount = this._getRecentCount(executorId, counterName);

    const categoryTrippedSizeRule =
      kind === 'category' &&
      typeof extra.childChannelCount === 'number' &&
      extra.childChannelCount >= config.thresholds.categoryChannelCount;

    const countTrippedThreshold =
      (kind === 'channel' && recentCount >= config.thresholds.channelDeletes) ||
      (kind === 'role' && recentCount >= config.thresholds.roleDeletes);

    const isMalicious = countTrippedThreshold || categoryTrippedSizeRule;

    if (isMalicious) {
      this._clearExecutor(executorId);
      RestoreManager.markIgnoredExecutor(guild.id, executorId);

      const target = await guild.members.fetch(executorId).catch(() => null);
      if (target) {
        await target
          .ban({ reason: `Anti-nuke: malicious ${kind} deletion pattern detected` })
          .catch((err) => console.error(`[DetectionManager] Failed to ban ${executorId}:`, err));
      }

      await RestoreManager.restoreFull(guild, `malicious-${kind}-deletion`);

      await LogManager.sendAlert(
        guild,
        `🚨 **Malicious ${kind} deletion pattern detected**\n` +
          `Executor: <@${executorId}> (${executorId})\n` +
          `${recentCount} ${kind} deletion(s) within the detection window.\n` +
          `Action taken: executor banned, server fully restored from blueprint.`
      );

      return { outcome: 'malicious', executorId, kind, recentCount };
    }

    await RestoreManager.restoreSingle(guild, kind, targetId);
    return { outcome: 'accident', executorId, kind, recentCount };
  }

  /**
   * Handles an unauthorized creation (channel/category/role). Unlike
   * deletions, a single unauthorized creation was already just a
   * PolicyManager-level "delete it back" case with no ban logic at all -
   * which left a real gap: a fast-moving malicious bot could keep
   * creating channels indefinitely without ever being banned, since each
   * one was just quietly deleted one at a time.
   *
   * Two independent thresholds, checked every time:
   *  - BURST: 3+ creations within 5 seconds (config.thresholds.creationBurst).
   *    A human cannot do this through the Discord UI; a script can. This
   *    is the "stop it immediately" path - it triggers on the 3rd event,
   *    not after minutes of accumulation.
   *  - SUSTAINED: same shape as the deletion thresholds (5+ within the
   *    normal 3-minute window), as a fallback for spam just under burst speed.
   *
   * The ban happens FIRST and is awaited before this method returns -
   * cleanup of the specific object that triggered this call happens in
   * the caller (PolicyManager), after this resolves. That ordering is
   * deliberate: stopping the executor from creating/posting more takes
   * priority over tidying up what already got created.
   *
   * @param {import('discord.js').Guild} guild
   * @param {'channel'|'category'|'role'} kind
   * @param {string} targetId
   * @param {string} executorId
   */
  async handleCreationEvent(guild, kind, targetId, executorId) {
    // Categories and channels share the same Discord audit action and the
    // same practical risk profile, so they share one counter/threshold.
    const counterKind = kind === 'category' ? 'channel' : kind;
    const counterName = `${counterKind}Creates`;

    this._recordAction(executorId, counterName);

    const burstCount = this._getRecentCountWithinMs(
      executorId,
      counterName,
      config.thresholds.creationBurst.windowMs
    );
    const sustainedCount = this._getRecentCount(executorId, counterName);

    const burstTripped = burstCount >= config.thresholds.creationBurst.count;
    const sustainedThreshold =
      counterKind === 'role' ? config.thresholds.roleCreates : config.thresholds.channelCreates;
    const sustainedTripped = sustainedCount >= sustainedThreshold;

    if (!burstTripped && !sustainedTripped) {
      return { outcome: 'creation-tracked', executorId, kind, burstCount, sustainedCount };
    }

    this._clearExecutor(executorId);
    RestoreManager.markIgnoredExecutor(guild.id, executorId);

    const target = await guild.members.fetch(executorId).catch(() => null);
    let banned = false;
    if (target) {
      banned = await target
        .ban({
          reason: `Anti-nuke: malicious ${kind} creation spam detected (${burstTripped ? 'burst' : 'sustained'} threshold, ${burstTripped ? burstCount : sustainedCount} in window)`,
        })
        .then(() => true)
        .catch((err) => {
          console.error(`[DetectionManager] Failed to ban ${executorId}:`, err);
          return false;
        });
    }

    await LogManager.sendAlert(
      guild,
      `🚨 **Malicious ${kind} creation spam detected**\n` +
        `Executor: <@${executorId}> (${executorId})\n` +
        `Trigger: ${burstTripped ? `${burstCount} creations in ${config.thresholds.creationBurst.windowMs / 1000}s (burst)` : `${sustainedCount} creations in the detection window (sustained)`}\n` +
        `Action taken: executor ${banned ? 'banned' : 'ban FAILED - check bot permissions'}.`
    );

    return { outcome: 'malicious-creation', executorId, kind, burstCount, sustainedCount, banned };
  }

  /**
   * Handles an already-attributed, already-policy-cleared ban or kick.
   *
   * Unlike deletions, a single unauthorized ban/kick is NOT treated as an
   * "accident" to be undone - banning/kicking one person is routine
   * moderation, not damage. Instead:
   *
   *  - If the action has an audit log reason attached, it's allowed through
   *    (still counted toward the malicious threshold, but not punished).
   *  - If it has no reason, the executor's ban/kick-granting roles are
   *    temporarily stripped (a proportionate response - not a full ban -
   *    for acting without justification).
   *  - Bans and kicks share ONE combined rolling counter per executor,
   *    since a raid could mix both to stay under separate thresholds.
   *    3+ combined within the window triggers the full attack response:
   *    ban the executor, ignore further events from them, and attempt to
   *    unban anyone they banned within the window. Kicked members cannot
   *    be restored (Discord has no "un-kick" API) - see README.
   *
   * @param {import('discord.js').Guild} guild
   * @param {'ban'|'kick'} kind
   * @param {string} targetUserId
   * @param {string} executorId
   * @param {string|null} reason
   */
  async handleMemberAction(guild, kind, targetUserId, executorId, reason) {
    this._recordAction(executorId, 'memberActions');
    const recentCount = this._getRecentCount(executorId, 'memberActions');

    const isMalicious = recentCount >= config.thresholds.banKickMalicious;

    if (isMalicious) {
      const windowStart = Date.now() - COUNTER_WINDOW_MS;
      this._clearExecutor(executorId);
      RestoreManager.markIgnoredExecutor(guild.id, executorId);

      const executorMember = await guild.members.fetch(executorId).catch(() => null);
      if (executorMember) {
        await executorMember
          .ban({ reason: `Anti-nuke: malicious mass ban/kick pattern detected (${recentCount} in window)` })
          .catch((err) => console.error(`[DetectionManager] Failed to ban ${executorId}:`, err));
      }

      const unbanned = await RestoreManager.unbanRecentTargets(guild, executorId, windowStart);
      console.warn(
        `[DetectionManager] Malicious ${kind} pattern from ${executorId} in ${guild.id}: ` +
          `banned executor, unbanned ${unbanned.length} target(s). ` +
          `Note: any kicked members in this window cannot be automatically restored.`
      );

      await LogManager.sendAlert(
        guild,
        `🚨 **Malicious mass ban/kick pattern detected**\n` +
          `Executor: <@${executorId}> (${executorId})\n` +
          `${recentCount} ban/kick action(s) within the detection window.\n` +
          `Action taken: executor banned, ${unbanned.length} banned target(s) restored. ` +
          `Kicked members cannot be automatically restored (Discord limitation).`
      );

      return { outcome: 'malicious-member-action', executorId, kind, recentCount, unbanned: unbanned.length };
    }

    if (reason && reason.trim().length > 0) {
      // Justified single action - allow it, no punishment, still counted above.
      return { outcome: 'permitted-with-reason', executorId, kind, recentCount };
    }

    // No reason provided - temporarily strip ban/kick-granting roles.
    const executorMember = await guild.members.fetch(executorId).catch(() => null);
    if (executorMember) {
      await RestoreManager.quarantinePermissions(
        guild,
        executorMember,
        `Anti-nuke: ${kind} performed with no audit log reason`
      );

      await LogManager.sendAlert(
        guild,
        `⚠️ **Ban/kick permissions temporarily revoked**\n` +
          `User: <@${executorId}> (${executorId})\n` +
          `Reason: performed a ${kind} with no audit log reason attached.\n` +
          `Their ban/kick-granting roles will be automatically restored in ${config.quarantineDurationMs / 60000} minute(s).`
      );
    }

    return { outcome: 'quarantined', executorId, kind, recentCount };
  }

  // ---------------------------------------------------------------------
  // Internal: rolling window counters
  // ---------------------------------------------------------------------

  _recordAction(executorId, counterName) {
    if (!this.executorCounters.has(executorId)) this.executorCounters.set(executorId, {});
    const entry = this.executorCounters.get(executorId);
    if (!entry[counterName]) entry[counterName] = [];
    entry[counterName].push(Date.now());
  }

  _getRecentCount(executorId, counterName) {
    const entry = this.executorCounters.get(executorId);
    if (!entry || !entry[counterName]) return 0;
    const cutoff = Date.now() - COUNTER_WINDOW_MS;
    entry[counterName] = entry[counterName].filter((ts) => ts >= cutoff);
    return entry[counterName].length;
  }

  /**
   * Like _getRecentCount but against an arbitrary (typically much shorter)
   * window, without mutating the stored array - used for burst detection
   * alongside the normal 3-minute sustained count.
   */
  _getRecentCountWithinMs(executorId, counterName, windowMs) {
    const entry = this.executorCounters.get(executorId);
    if (!entry || !entry[counterName]) return 0;
    const cutoff = Date.now() - windowMs;
    return entry[counterName].filter((ts) => ts >= cutoff).length;
  }

  _clearExecutor(executorId) {
    this.executorCounters.delete(executorId);
  }

  _cleanup() {
    const cutoff = Date.now() - COUNTER_WINDOW_MS;
    for (const [executorId, counters] of this.executorCounters) {
      let isEmpty = true;
      for (const key of Object.keys(counters)) {
        counters[key] = counters[key].filter((ts) => ts >= cutoff);
        if (counters[key].length > 0) isEmpty = false;
      }
      if (isEmpty) this.executorCounters.delete(executorId);
    }
  }
}

module.exports = new DetectionManager();
