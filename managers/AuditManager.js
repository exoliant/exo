const PROCESSED_ENTRY_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BATCH_DELAY_MS = 1500; // wait for events to cluster before fetching
const MAX_STALE_MS = 5000; // audit entry must be within 5s of the event to count
const FETCH_LIMIT = 15;

/**
 * AuditManager's sole responsibility: answer who performed a given action,
 * on what target, and when - as accurately as possible, with no duplicate
 * processing. It knows nothing about whitelisting, thresholds, or
 * restoration; that logic lives in PolicyManager, DetectionManager, and
 * RestoreManager respectively.
 *
 * Callers pass a raw discord.js AuditLogEvent value (see utils/constants.js)
 * rather than an internal action name, so adding a new protected resource
 * type never requires touching this file.
 */
class AuditManager {
  constructor() {
    // entryId -> { executorId, targetId, auditEventType, timestamp, expiresAt }
    // Prevents the same audit log entry from ever being attributed twice,
    // even if two different code paths race to resolve overlapping events.
    this.processedEntries = new Map();

    // guildId -> { timer, requests: [{ auditEventType, targetId, eventTimestamp, resolve }] }
    this.pendingByGuild = new Map();

    // periodic cleanup so the processed-entry cache doesn't grow unbounded
    setInterval(() => this._cleanup(), 60 * 1000).unref();
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Resolves the executor responsible for a given audit-logged action on a
   * specific target. Batches concurrent requests for the same guild into a
   * single audit log fetch.
   *
   * @param {import('discord.js').Guild} guild
   * @param {number} auditEventType - a discord.js AuditLogEvent value
   * @param {string} targetId - ID of the affected object (or guild.id for guild-level events)
   * @param {number} eventTimestamp - Date.now() at the moment the event fired
   * @returns {Promise<{executorId: string, entryId: string, timestamp: number, reason: string|null} | null>}
   */
  resolveExecutor(guild, auditEventType, targetId, eventTimestamp = Date.now()) {
    return new Promise((resolve) => {
      const guildId = guild.id;

      if (!this.pendingByGuild.has(guildId)) {
        this.pendingByGuild.set(guildId, { timer: null, requests: [] });
      }

      const bucket = this.pendingByGuild.get(guildId);
      bucket.requests.push({ auditEventType, targetId, eventTimestamp, resolve });

      if (!bucket.timer) {
        bucket.timer = setTimeout(() => {
          this._flushGuild(guild).catch((err) => {
            console.error(`[AuditManager] Flush failed for guild ${guildId}:`, err);
            // Resolve any still-pending requests with null so callers don't hang.
            const b = this.pendingByGuild.get(guildId);
            if (b) {
              b.requests.forEach((r) => r.resolve(null));
              this.pendingByGuild.delete(guildId);
            }
          });
        }, BATCH_DELAY_MS);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------

  async _flushGuild(guild) {
    const guildId = guild.id;
    const bucket = this.pendingByGuild.get(guildId);
    if (!bucket) return;

    this.pendingByGuild.delete(guildId); // new requests during fetch start a fresh bucket
    const { requests } = bucket;

    let logs;
    try {
      logs = await guild.fetchAuditLogs({ limit: FETCH_LIMIT });
    } catch (err) {
      console.error(`[AuditManager] fetchAuditLogs failed for guild ${guildId}:`, err);
      requests.forEach((r) => r.resolve(null));
      return;
    }

    const entries = [...logs.entries.values()];

    for (const req of requests) {
      const match = entries.find((entry) => {
        if (entry.action !== req.auditEventType) return false;
        if (!entry.target || entry.target.id !== req.targetId) return false;
        if (this.processedEntries.has(entry.id)) return false;
        if (entry.createdTimestamp < req.eventTimestamp - MAX_STALE_MS) return false;
        return true;
      });

      if (!match) {
        req.resolve(null);
        continue;
      }

      this.processedEntries.set(match.id, {
        executorId: match.executorId,
        targetId: req.targetId,
        auditEventType: req.auditEventType,
        timestamp: match.createdTimestamp,
        reason: match.reason ?? null,
        expiresAt: Date.now() + PROCESSED_ENTRY_TTL_MS,
      });

      req.resolve({
        executorId: match.executorId,
        entryId: match.id,
        timestamp: match.createdTimestamp,
        reason: match.reason ?? null,
      });
    }
  }

  _cleanup() {
    const now = Date.now();
    for (const [entryId, data] of this.processedEntries) {
      if (data.expiresAt <= now) this.processedEntries.delete(entryId);
    }
  }
}

module.exports = new AuditManager();
