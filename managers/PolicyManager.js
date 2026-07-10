const AuditManager = require('./AuditManager');
const WhitelistManager = require('./WhitelistManager');
const BlueprintManager = require('./BlueprintManager');
const RestoreManager = require('./RestoreManager');
const DetectionManager = require('./DetectionManager');
const { getAuditEventType, buildWhitelistActionKey, getMemberAuditEventType } = require('../utils/constants');

const EVENT_DEDUP_TTL_MS = 20 * 1000; // protects against duplicate gateway deliveries

/**
 * PolicyManager answers one question for every event: "is this executor
 * allowed to make this change?" It is the single entry point every event
 * handler calls. Everything downstream trusts that by the time it's
 * invoked, attribution, rank, whitelist, and duplicate/self-echo checks
 * have already happened.
 *
 * Responsibilities kept OUT of this file on purpose:
 *  - Who performed the action (AuditManager)
 *  - Whether a destructive pattern is malicious (DetectionManager)
 *  - How repair/reversion is actually carried out (RestoreManager)
 *  - What the source-of-truth state is (BlueprintManager)
 */
class PolicyManager {
  constructor() {
    // dedup key -> expiry timestamp; protects ALL event kinds, not just deletes
    this.eventCache = new Map();
    setInterval(() => this._cleanup(), 30 * 1000).unref();
  }

  /**
   * @param {import('discord.js').Guild} guild
   * @param {'channel'|'category'|'role'|'guild'} kind
   * @param {'create'|'update'|'delete'} action
   * @param {string} targetId - id of the affected object, or guild.id for guild-level events
   * @param {Object} [extra] - passed through to DetectionManager for delete events (e.g. childChannelCount)
   */
  async evaluate(guild, kind, action, targetId, extra = {}) {
    // Same reasoning as evaluateMemberAction: no blueprint means no
    // established baseline, so there's nothing to enforce. Checked first
    // to also skip the audit log fetch for guilds that never ran !save.
    if (!BlueprintManager.exists(guild.id)) {
      return { outcome: 'no-blueprint' };
    }

    // --- Layer 1: event-level dedup (any kind/action) ---
    const dedupKey = `${kind}:${action}:${guild.id}:${targetId}`;
    if (this.eventCache.has(dedupKey)) {
      return { outcome: 'duplicate' };
    }
    this.eventCache.set(dedupKey, Date.now() + EVENT_DEDUP_TTL_MS);

    // --- Self-echo: is this event the result of our own repair action? ---
    if (RestoreManager.isIgnoredTarget(targetId)) {
      RestoreManager.clearIgnoredTarget(targetId);
      return { outcome: 'self-echo' };
    }

    // --- Restoration in progress: defer rather than double-process ---
    if (RestoreManager.isRestoring(guild.id)) {
      if (action === 'delete') {
        RestoreManager.enqueueRepairCheck(guild, kind, targetId);
      }
      // Creates/updates during a full restore will be caught by the
      // post-restore diff/cleanup pass; no need to act on them now.
      return { outcome: 'restoration-in-progress' };
    }

    // --- Resolve executor ---
    const auditEventType = getAuditEventType(kind, action);
    const resolved = auditEventType
      ? await AuditManager.resolveExecutor(guild, auditEventType, targetId, Date.now())
      : null;

    if (!resolved) {
      // Can't confidently attribute this. For deletes, restore defensively
      // (an unattributed loss is still a loss). For create/update, do
      // nothing rather than guess - reverting/deleting based on an
      // unknown actor risks undoing a legitimate admin's work.
      if (action === 'delete') {
        await RestoreManager.restoreSingle(guild, kind, targetId);
      }
      return { outcome: 'unresolved' };
    }

    const { executorId } = resolved;

    // --- Self-action guard: never evaluate the bot's own actions ---
    const botId = guild.client.user.id;
    if (executorId === botId) {
      return { outcome: 'self-action' };
    }

    // --- Banned-executor straggler guard ---
    if (RestoreManager.isIgnoredExecutor(guild.id, executorId)) {
      return { outcome: 'ignored-executor' };
    }

    // --- Rank check: can the bot even moderate this user? ---
    const executorMember = await guild.members.fetch(executorId).catch(() => null);
    if (executorMember && !this._canModerate(guild, executorMember)) {
      await BlueprintManager.updateFromChange(guild, { type: kind, action, id: targetId });
      return { outcome: 'blueprint-updated', reason: 'executor-outranks-bot', executorId };
    }

    // --- Whitelist check: granular per-action, per-resource ---
    const whitelistAction = buildWhitelistActionKey(kind, action); // e.g. "deleteChannel", "updateRole"
    if (WhitelistManager.isPermitted(guild.id, executorId, whitelistAction, targetId)) {
      await BlueprintManager.updateFromChange(guild, { type: kind, action, id: targetId });
      return { outcome: 'blueprint-updated', reason: 'whitelisted', executorId };
    }

    // --- Not allowed: branch by action type ---
    if (action === 'delete') {
      // Destructive - hand off to DetectionManager for the accident/malicious call.
      const result = await DetectionManager.handleDestructiveEvent(guild, kind, targetId, executorId, extra);
      return { outcome: result.outcome, executorId, kind, recentCount: result.recentCount };
    }

    if (action === 'create') {
      // Threshold/ban analysis happens first (and is awaited) - stopping a
      // fast-moving executor takes priority over cleaning up what they've
      // already created. The object gets deleted either way, whether this
      // was malicious or just a single unauthorized creation.
      const result = await DetectionManager.handleCreationEvent(guild, kind, targetId, executorId);
      await RestoreManager.deleteUnauthorizedCreation(guild, kind, targetId);
      return { outcome: result.outcome, executorId, kind };
    }

    // action === 'update'
    if (kind === 'guild') {
      await RestoreManager.revertGuildSettings(guild);
    } else {
      await RestoreManager.revertChange(guild, kind, targetId);
    }
    return { outcome: 'reverted-update', executorId, kind };
  }

  /**
   * Evaluates a ban or kick. Distinct from evaluate() because ban/kick
   * aren't structural changes with a "blueprint" to update or revert to -
   * they're member-targeted actions. Authorized ones (whitelisted, or by
   * someone who outranks the bot) are simply left alone. Unauthorized ones
   * are handed to DetectionManager, which applies the reason-based
   * single-action policy plus the combined malicious threshold.
   *
   * @param {import('discord.js').Guild} guild
   * @param {'ban'|'kick'} kind
   * @param {string} targetUserId
   */
  async evaluateMemberAction(guild, kind, targetUserId) {
    // This feature only activates once an owner has established a baseline
    // via !save. Without a blueprint, there's no "known-good state" to
    // protect, and enforcing bans/quarantine on a server that never opted
    // in would be surprising and unaccountable. Checked before resolving
    // the executor to also skip the audit log fetch entirely.
    if (!BlueprintManager.exists(guild.id)) {
      return { outcome: 'no-blueprint' };
    }

    const dedupKey = `member:${kind}:${guild.id}:${targetUserId}`;
    if (this.eventCache.has(dedupKey)) {
      return { outcome: 'duplicate' };
    }
    this.eventCache.set(dedupKey, Date.now() + EVENT_DEDUP_TTL_MS);

    if (RestoreManager.isRestoring(guild.id)) {
      return { outcome: 'restoration-in-progress' };
    }

    const auditEventType = getMemberAuditEventType(kind);
    const resolved = await AuditManager.resolveExecutor(guild, auditEventType, targetUserId, Date.now());

    if (!resolved) {
      // For kicks specifically, this is also how we correctly ignore
      // voluntary leaves and bans (which fire guildMemberRemove too but
      // won't have a matching MemberKick audit entry).
      return { outcome: 'unresolved' };
    }

    const { executorId, reason } = resolved;

    const botId = guild.client.user.id;
    if (executorId === botId) {
      return { outcome: 'self-action' };
    }

    if (RestoreManager.isIgnoredExecutor(guild.id, executorId)) {
      return { outcome: 'ignored-executor' };
    }

    const executorMember = await guild.members.fetch(executorId).catch(() => null);
    if (executorMember && !this._canModerate(guild, executorMember)) {
      // Can't moderate this user anyway - nothing to do; not a config
      // change, so there's no blueprint entry to update either.
      return { outcome: 'authorized-outranked', executorId };
    }

    const whitelistAction = kind === 'ban' ? 'banMember' : 'kickMember';
    if (WhitelistManager.isPermitted(guild.id, executorId, whitelistAction, targetUserId)) {
      return { outcome: 'authorized-whitelisted', executorId };
    }

    const result = await DetectionManager.handleMemberAction(guild, kind, targetUserId, executorId, reason);
    return { outcome: result.outcome, executorId, kind, recentCount: result.recentCount };
  }

  _canModerate(guild, member) {
    const botMember = guild.members.me;
    if (!botMember) return false;
    return botMember.roles.highest.position > member.roles.highest.position;
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, expiry] of this.eventCache) {
      if (expiry <= now) this.eventCache.delete(key);
    }
  }
}

module.exports = new PolicyManager();
