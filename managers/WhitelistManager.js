const fs = require('fs');
const path = require('path');
const config = require('../config');

const WHITELIST_DIR = path.join(__dirname, '..', 'data', 'whitelist');

/**
 * Whitelist permission shape (per guild file, e.g. data/whitelist/<guildId>.json):
 *
 * {
 *   "<userId>": {
 *     "deleteChannel": [],              // empty array = allowed anywhere
 *     "deleteCategory": ["112233445566"], // array of IDs = allowed only on those resources
 *     "deleteRole": []
 *   }
 * }
 *
 * Rules:
 *  - No entry for the user at all           -> not permitted for anything
 *  - Entry exists, action key missing       -> not permitted for that action
 *  - Action key exists, value is []         -> permitted for that action on ANY resource
 *  - Action key exists, value is [id, ...]  -> permitted only when resourceId is in the list
 */
class WhitelistManager {
  constructor() {
    // guildId -> { userId -> { action -> string[] } }
    this.cache = new Map();

    if (!fs.existsSync(WHITELIST_DIR)) {
      fs.mkdirSync(WHITELIST_DIR, { recursive: true });
    }
  }

  _filePath(guildId) {
    return path.join(WHITELIST_DIR, `${guildId}.json`);
  }

  /**
   * Loads a guild's whitelist from disk into cache (if not already cached).
   */
  _load(guildId) {
    if (this.cache.has(guildId)) return this.cache.get(guildId);

    const filePath = this._filePath(guildId);
    let data = {};

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        data = raw.trim().length ? JSON.parse(raw) : {};
      } catch (err) {
        // Corrupt file: don't crash the bot, just treat as empty and log it.
        console.error(`[WhitelistManager] Failed to parse whitelist for guild ${guildId}:`, err);
        data = {};
      }
    }

    this.cache.set(guildId, data);
    return data;
  }

  /**
   * Persists a guild's whitelist from cache to disk.
   */
  _save(guildId) {
    const data = this.cache.get(guildId) || {};
    const filePath = this._filePath(guildId);
    // Write to a temp file first then rename, to avoid partial writes if the
    // process dies mid-write (e.g. during a nuke event storm).
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Core permission check. This is what every detector calls.
   *
   * @param {string} guildId
   * @param {string} userId
   * @param {string} action - e.g. "deleteChannel", "deleteCategory", "deleteRole"
   * @param {string|null} resourceId - the ID of the specific channel/category/role affected
   * @returns {boolean}
   */
  isPermitted(guildId, userId, action, resourceId = null) {
    const guildData = this._load(guildId);
    const userEntry = guildData[userId];

    if (!userEntry) return false;
    if (!Object.prototype.hasOwnProperty.call(userEntry, action)) return false;

    const allowedIds = userEntry[action];

    // Empty array = unrestricted for this action.
    if (Array.isArray(allowedIds) && allowedIds.length === 0) return true;

    // Non-empty array = must match the specific resource.
    if (Array.isArray(allowedIds) && resourceId) {
      return allowedIds.includes(resourceId);
    }

    return false;
  }

  /**
   * Grants a permission to a user. If resourceId is omitted, grants unrestricted
   * access for that action (sets to []). If resourceId is provided, adds it to
   * the allowed list without wiping existing entries.
   */
  grant(guildId, userId, action, resourceId = null) {
    const guildData = this._load(guildId);

    if (!guildData[userId]) guildData[userId] = {};

    if (resourceId === null) {
      // Unrestricted grant for this action.
      guildData[userId][action] = [];
    } else {
      const existing = guildData[userId][action];
      if (!Array.isArray(existing)) {
        guildData[userId][action] = [resourceId];
      } else if (existing.length > 0 && !existing.includes(resourceId)) {
        existing.push(resourceId);
      }
      // If existing is already [] (unrestricted), leave it as unrestricted -
      // adding a specific ID on top of "any" would be a no-op/downgrade.
    }

    this.cache.set(guildId, guildData);
    this._save(guildId);
    return guildData[userId];
  }

  /**
   * Revokes a permission. If resourceId is omitted, removes the action entirely.
   * If resourceId is provided, removes just that ID from the allowed list.
   */
  revoke(guildId, userId, action, resourceId = null) {
    const guildData = this._load(guildId);
    const userEntry = guildData[userId];
    if (!userEntry || !userEntry[action]) return false;

    if (resourceId === null) {
      delete userEntry[action];
    } else if (Array.isArray(userEntry[action])) {
      userEntry[action] = userEntry[action].filter((id) => id !== resourceId);
    }

    this.cache.set(guildId, guildData);
    this._save(guildId);
    return true;
  }

  /**
   * Removes a user from the whitelist entirely.
   */
  removeUser(guildId, userId) {
    const guildData = this._load(guildId);
    if (!guildData[userId]) return false;
    delete guildData[userId];
    this.cache.set(guildId, guildData);
    this._save(guildId);
    return true;
  }

  /**
   * Returns the full permission entry for a user (for !whitelist list commands).
   */
  getUserEntry(guildId, userId) {
    const guildData = this._load(guildId);
    return guildData[userId] || null;
  }

  /**
   * Returns the whole guild whitelist (for admin inspection commands).
   */
  getGuildWhitelist(guildId) {
    return this._load(guildId);
  }

  /**
   * Gate for who is allowed to run !save and !whitelist at all.
   * This is separate from the per-guild granular whitelist above -
   * it's a single global owner check from config, per your spec.
   */
  canManageWhitelist(userId) {
    return userId === config.ownerId;
  }
}

module.exports = new WhitelistManager();
