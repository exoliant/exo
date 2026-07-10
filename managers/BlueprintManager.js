const fs = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');

const BLUEPRINT_DIR = path.join(__dirname, '..', 'data', 'blueprints');

/**
 * Blueprint schema (data/blueprints/<guildId>.json):
 *
 * {
 *   "guildId": "...",
 *   "savedAt": 1720000000000,
 *   "roles": [
 *     { "id", "name", "color", "hoist", "mentionable", "permissions" (bitfield string), "position" }
 *   ],
 *   "categories": [
 *     { "id", "name", "position", "permissionOverwrites": [{ "id", "type", "allow", "deny" }] }
 *   ],
 *   "channels": [
 *     {
 *       "id", "name", "type", "parentId", "position", "topic", "nsfw",
 *       "rateLimitPerUser", "bitrate", "userLimit",
 *       "permissionOverwrites": [{ "id", "type", "allow", "deny" }]
 *     }
 *   ]
 * }
 *
 * Notes:
 *  - "type" is a raw discord.js ChannelType. "categories" are stored separately
 *    from "channels" for clarity, even though categories are technically
 *    ChannelType.GuildCategory channels under the hood.
 *  - permissionOverwrites store allow/deny as bitfield strings (BigInt-safe).
 *  - @everyone role is included in "roles" like any other role.
 */
class BlueprintManager {
  constructor() {
    this.cache = new Map(); // guildId -> blueprint object

    if (!fs.existsSync(BLUEPRINT_DIR)) {
      fs.mkdirSync(BLUEPRINT_DIR, { recursive: true });
    }
  }

  _filePath(guildId) {
    return path.join(BLUEPRINT_DIR, `${guildId}.json`);
  }

  // ---------------------------------------------------------------------
  // Load / persist
  // ---------------------------------------------------------------------

  load(guildId) {
    if (this.cache.has(guildId)) return this.cache.get(guildId);

    const filePath = this._filePath(guildId);
    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const blueprint = JSON.parse(raw);
      this.cache.set(guildId, blueprint);
      return blueprint;
    } catch (err) {
      console.error(`[BlueprintManager] Failed to load blueprint for ${guildId}:`, err);
      return null;
    }
  }

  exists(guildId) {
    return this.cache.has(guildId) || fs.existsSync(this._filePath(guildId));
  }

  _persist(guildId) {
    const blueprint = this.cache.get(guildId);
    if (!blueprint) return;

    const filePath = this._filePath(guildId);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(blueprint, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  // ---------------------------------------------------------------------
  // Full save (!save command)
  // ---------------------------------------------------------------------

  /**
   * Builds a full blueprint from the guild's current live state and persists it.
   * @param {import('discord.js').Guild} guild
   */
  async save(guild) {
    const roles = guild.roles.cache.map((role) => this._serializeRole(role));

    const categories = [];
    const channels = [];

    for (const channel of guild.channels.cache.values()) {
      if (channel.type === ChannelType.GuildCategory) {
        categories.push(this._serializeCategory(channel));
      } else {
        channels.push(this._serializeChannel(channel));
      }
    }

    const blueprint = {
      guildId: guild.id,
      savedAt: Date.now(),
      guild: this._serializeGuildSettings(guild),
      roles,
      categories,
      channels,
    };

    this.cache.set(guild.id, blueprint);
    this._persist(guild.id);
    return blueprint;
  }

  /**
   * Serializes the subset of guild-level (server) settings we protect.
   * Extend this object (and the guildUpdate handling in PolicyManager/
   * RestoreManager) to cover more properties as needed - e.g. banner,
   * description, preferred locale, features.
   */
  _serializeGuildSettings(guild) {
    return {
      name: guild.name,
      iconHash: guild.icon,
      verificationLevel: guild.verificationLevel,
      explicitContentFilter: guild.explicitContentFilter,
      defaultMessageNotifications: guild.defaultMessageNotifications,
      systemChannelId: guild.systemChannelId,
      afkChannelId: guild.afkChannelId,
      afkTimeout: guild.afkTimeout,
    };
  }

  // ---------------------------------------------------------------------
  // Serialization helpers
  // ---------------------------------------------------------------------

  _serializePermissionOverwrites(overwrites) {
    return [...overwrites.cache.values()].map((ow) => ({
      id: ow.id,
      type: ow.type, // 0 = role, 1 = member
      allow: ow.allow.bitfield.toString(),
      deny: ow.deny.bitfield.toString(),
    }));
  }

  _serializeRole(role) {
    return {
      id: role.id,
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: role.permissions.bitfield.toString(),
      position: role.position,
      unicodeEmoji: role.unicodeEmoji ?? null,
      // iconHash is stored so changes can be DETECTED (see utils/compare.js),
      // but it cannot be RESTORED from a hash alone - same known limitation
      // as guild icons/banners. See RestoreManager.revertChange.
      iconHash: role.icon ?? null,
    };
  }

  _serializeCategory(category) {
    return {
      id: category.id,
      name: category.name,
      position: category.position,
      permissionOverwrites: this._serializePermissionOverwrites(category.permissionOverwrites),
    };
  }

  _serializeChannel(channel) {
    return {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parentId: channel.parentId || null,
      position: channel.position,
      topic: 'topic' in channel ? channel.topic ?? null : null,
      nsfw: 'nsfw' in channel ? Boolean(channel.nsfw) : false,
      rateLimitPerUser: 'rateLimitPerUser' in channel ? channel.rateLimitPerUser ?? 0 : 0,
      bitrate: 'bitrate' in channel ? channel.bitrate ?? null : null,
      userLimit: 'userLimit' in channel ? channel.userLimit ?? null : null,
      permissionOverwrites: this._serializePermissionOverwrites(channel.permissionOverwrites),
    };
  }

  // ---------------------------------------------------------------------
  // Partial update (for changes made by users the bot can't moderate,
  // and for permitted whitelisted actions - update instead of revert)
  // ---------------------------------------------------------------------

  /**
   * Applies a single change to the cached blueprint and persists it.
   *
   * @param {import('discord.js').Guild} guild - needed to re-read live state on create/update
   * @param {Object} change
   * @param {'role'|'category'|'channel'} change.type
   * @param {'create'|'update'|'delete'} change.action
   * @param {string} change.id
   */
  updateFromChange(guild, change) {
    const blueprint = this.load(guild.id);
    if (!blueprint) {
      // Nothing to update against - there's no baseline yet. Silently skip;
      // the next !save will capture current state.
      return null;
    }

    const { type, action, id } = change;

    if (type === 'guild') {
      // Singleton - no id-keyed list, just re-serialize current settings.
      blueprint.guild = this._serializeGuildSettings(guild);
      blueprint.savedAt = Date.now();
      this.cache.set(guild.id, blueprint);
      this._persist(guild.id);
      return blueprint;
    }

    const listKey = type === 'role' ? 'roles' : type === 'category' ? 'categories' : 'channels';
    const list = blueprint[listKey];

    if (action === 'delete') {
      blueprint[listKey] = list.filter((entry) => entry.id !== id);
    } else {
      // create or update: re-serialize current live state and upsert.
      let liveObject = null;
      if (type === 'role') liveObject = guild.roles.cache.get(id);
      else liveObject = guild.channels.cache.get(id);

      if (!liveObject) {
        // Object vanished before we could re-read it (e.g. rapid create+delete).
        // Treat as a delete to keep the blueprint consistent.
        blueprint[listKey] = list.filter((entry) => entry.id !== id);
      } else {
        const serialized =
          type === 'role'
            ? this._serializeRole(liveObject)
            : type === 'category'
            ? this._serializeCategory(liveObject)
            : this._serializeChannel(liveObject);

        const idx = list.findIndex((entry) => entry.id === id);
        if (idx === -1) list.push(serialized);
        else list[idx] = serialized;
      }
    }

    blueprint.savedAt = Date.now();
    this.cache.set(guild.id, blueprint);
    this._persist(guild.id);
    return blueprint;
  }

  /**
   * Updates a blueprint entry's ID in place after RestoreManager recreates an
   * object and Discord assigns it a new snowflake. Without this, the next
   * diff() would see the old ID as still "missing" forever, since a brand
   * new ID can never equal it.
   *
   * @param {string} guildId
   * @param {'role'|'category'|'channel'} type
   * @param {string} oldId
   * @param {string} newId
   */
  remapId(guildId, type, oldId, newId) {
    const blueprint = this.load(guildId);
    if (!blueprint) return false;

    const listKey = type === 'role' ? 'roles' : type === 'category' ? 'categories' : 'channels';
    const entry = blueprint[listKey].find((e) => e.id === oldId);
    if (!entry) return false;

    entry.id = newId;

    // Channels/categories may reference the old category ID as parentId elsewhere.
    if (type === 'category') {
      for (const chan of blueprint.channels) {
        if (chan.parentId === oldId) chan.parentId = newId;
      }
    }

    this.cache.set(guildId, blueprint);
    this._persist(guildId);
    return true;
  }

  // ---------------------------------------------------------------------
  // Diff (compares live guild state against the saved blueprint)
  // ---------------------------------------------------------------------


  /**
   * Returns a structured diff describing what's missing, extra, or changed
   * relative to the blueprint. Used by RestoreManager to decide what to
   * recreate/adjust, and by a manual !restore preview if desired.
   *
   * @param {import('discord.js').Guild} guild
   */
  diff(guild) {
    const blueprint = this.load(guild.id);
    if (!blueprint) return null;

    const result = {
      changedGuildSettings: null,
      missingRoles: [],
      extraRoles: [],
      changedRoles: [],
      missingCategories: [],
      extraCategories: [],
      changedCategories: [],
      missingChannels: [],
      extraChannels: [],
      changedChannels: [],
    };

    const liveGuildSettings = this._serializeGuildSettings(guild);
    if (JSON.stringify(liveGuildSettings) !== JSON.stringify(blueprint.guild)) {
      result.changedGuildSettings = { before: blueprint.guild, after: liveGuildSettings };
    }

    this._diffList(
      blueprint.roles,
      guild.roles.cache,
      result.missingRoles,
      result.extraRoles,
      result.changedRoles,
      (live) => this._serializeRole(live)
    );

    const liveCategories = new Map(
      [...guild.channels.cache.values()]
        .filter((c) => c.type === ChannelType.GuildCategory)
        .map((c) => [c.id, c])
    );
    this._diffList(
      blueprint.categories,
      liveCategories,
      result.missingCategories,
      result.extraCategories,
      result.changedCategories,
      (live) => this._serializeCategory(live)
    );

    const liveChannels = new Map(
      [...guild.channels.cache.values()]
        .filter((c) => c.type !== ChannelType.GuildCategory)
        .map((c) => [c.id, c])
    );
    this._diffList(
      blueprint.channels,
      liveChannels,
      result.missingChannels,
      result.extraChannels,
      result.changedChannels,
      (live) => this._serializeChannel(live)
    );

    return result;
  }

  /**
   * Generic diff helper: compares a blueprint list against a live Collection/Map
   * keyed by id, sorting entries into missing / extra / changed.
   */
  _diffList(blueprintList, liveCollection, missingOut, extraOut, changedOut, serializeFn) {
    const blueprintById = new Map(blueprintList.map((entry) => [entry.id, entry]));
    const liveIds = new Set(liveCollection.keys ? liveCollection.keys() : []);

    // Missing: in blueprint but not live -> needs to be recreated.
    for (const entry of blueprintList) {
      if (!liveCollection.get(entry.id)) missingOut.push(entry);
    }

    // Extra: live but not in blueprint -> not part of the known-good state.
    for (const [id, live] of liveCollection.entries()) {
      if (!blueprintById.has(id)) extraOut.push(serializeFn(live));
    }

    // Changed: exists in both, but serialized form differs.
    for (const [id, live] of liveCollection.entries()) {
      const blueprintEntry = blueprintById.get(id);
      if (!blueprintEntry) continue;
      const liveSerialized = serializeFn(live);
      if (JSON.stringify(liveSerialized) !== JSON.stringify(blueprintEntry)) {
        changedOut.push({ before: blueprintEntry, after: liveSerialized });
      }
    }
  }
}

module.exports = new BlueprintManager();
