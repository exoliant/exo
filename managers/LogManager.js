const fs = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');

const SETTINGS_DIR = path.join(__dirname, '..', 'data', 'settings');

/**
 * LogManager owns exactly one thing per guild: where alert messages get
 * posted. It's deliberately self-healing - if the configured channel is
 * ever deleted (by an attacker, by accident, whatever), the next attempt
 * to send an alert transparently recreates it rather than failing or
 * throwing. Every public method is safe to call even when no log channel
 * has been configured at all - it just becomes a silent no-op.
 */
class LogManager {
  constructor() {
    this.cache = new Map(); // guildId -> { channelId, channelName }
    this._recreateInFlight = new Map(); // guildId -> Promise<channel|null>, prevents duplicate concurrent recreation

    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  }

  _filePath(guildId) {
    return path.join(SETTINGS_DIR, `${guildId}.json`);
  }

  _load(guildId) {
    if (this.cache.has(guildId)) return this.cache.get(guildId);

    const filePath = this._filePath(guildId);
    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = raw.trim().length ? JSON.parse(raw) : null;
      if (data) this.cache.set(guildId, data);
      return data;
    } catch (err) {
      console.error(`[LogManager] Failed to load settings for guild ${guildId}:`, err);
      return null;
    }
  }

  _persist(guildId, data) {
    this.cache.set(guildId, data);
    try {
      const filePath = this._filePath(guildId);
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      console.error(`[LogManager] Failed to persist settings for guild ${guildId}:`, err);
    }
  }

  /**
   * Sets (or replaces) the single log channel for a guild. Only one log
   * channel can be configured per guild - calling this again overwrites
   * whatever was set before.
   */
  setLogChannel(guildId, channelId, channelName) {
    this._persist(guildId, { channelId, channelName });
  }

  getLogChannel(guildId) {
    return this._load(guildId);
  }

  clearLogChannel(guildId) {
    this.cache.delete(guildId);
    try {
      fs.unlinkSync(this._filePath(guildId));
    } catch {
      // fine if it never existed
    }
  }

  /**
   * Sends an alert to the guild's configured log channel. Never throws -
   * any failure (no channel configured, channel deleted and unrecreatable,
   * missing permissions) is caught and logged to console instead, so a
   * logging failure can never take down the caller's actual enforcement
   * action.
   *
   * @param {import('discord.js').Guild} guild
   * @param {string} content
   */
  async sendAlert(guild, content) {
    const settings = this.getLogChannel(guild.id);
    if (!settings) return; // no log channel configured - silent no-op by design

    let channel = guild.channels.cache.get(settings.channelId);

    if (!channel) {
      channel = await this._resolveMissingChannel(guild, settings);
    }

    if (!channel) return; // couldn't send this time; already logged below

    try {
      await channel.send(content);
    } catch (err) {
      console.error(`[LogManager] Failed to send alert to log channel in ${guild.id}:`, err);
    }
  }

  /**
   * Handles a missing log channel: first checks whether a channel with the
   * same name already exists (it may have been recreated by the normal
   * blueprint-restore system under a new ID, if the log channel happened
   * to also be part of the blueprint) and adopts it rather than creating a
   * duplicate. Only creates a brand new channel if nothing matching is found.
   * Concurrent calls for the same guild share one in-flight recreation
   * rather than racing to create multiple channels.
   */
  async _resolveMissingChannel(guild, settings) {
    const existingByName = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === settings.channelName
    );
    if (existingByName) {
      this.setLogChannel(guild.id, existingByName.id, existingByName.name);
      return existingByName;
    }

    if (this._recreateInFlight.has(guild.id)) {
      return this._recreateInFlight.get(guild.id);
    }

    const recreation = (async () => {
      try {
        const created = await guild.channels.create({
          name: settings.channelName || 'mod-logs',
          type: ChannelType.GuildText,
          reason: 'Anti-nuke: recreating missing log channel',
        });
        this.setLogChannel(guild.id, created.id, created.name);
        console.warn(`[LogManager] Log channel was missing in ${guild.id}; recreated as #${created.name}.`);
        return created;
      } catch (err) {
        console.error(`[LogManager] Failed to recreate missing log channel in ${guild.id}:`, err);
        return null;
      } finally {
        this._recreateInFlight.delete(guild.id);
      }
    })();

    this._recreateInFlight.set(guild.id, recreation);
    return recreation;
  }
}

module.exports = new LogManager();
