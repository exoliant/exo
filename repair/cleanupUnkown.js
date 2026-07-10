const { ChannelType } = require('discord.js');
const { deleteLimiter } = require('../utils/rateLimiters');

/**
 * Removes objects that exist live but are not recognized by the blueprint.
 * This is ONLY called from RestoreManager.restoreFull() (the attack path).
 * The accident path (restoreSingle) must never call this - accidental
 * deletions don't imply new objects are unauthorized.
 *
 * Exemptions (never deleted even if "extra"):
 *  - @everyone role (id === guild.id)
 *  - Managed roles (role.managed === true) - bot/integration roles
 *  - Roles positioned above the bot's highest role (bot can't touch them anyway)
 *  - Channels/categories the bot lacks permission to manage
 *
 * Deletions are parallelized (bounded by the shared deleteLimiter) rather
 * than run one at a time - roles/categories/channels are independent of
 * each other here (deleting a category doesn't cascade-delete its former
 * children in Discord), so there's no ordering requirement to preserve.
 *
 * @param {import('discord.js').Guild} guild
 * @param {Object} diffResult - output of BlueprintManager.diff(guild)
 * @returns {Promise<{deletedChannels: string[], deletedCategories: string[], deletedRoles: string[], skipped: {id: string, type: string, reason: string}[]}>}
 */
async function cleanupUnknown(guild, diffResult) {
  const result = {
    deletedChannels: [],
    deletedCategories: [],
    deletedRoles: [],
    skipped: [],
  };

  if (!diffResult) return result;

  const botMember = guild.members.me;
  const botHighestPosition = botMember ? botMember.roles.highest.position : 0;

  const roleTasks = diffResult.extraRoles.map(async (roleData) => {
    const role = guild.roles.cache.get(roleData.id);
    if (!role) return; // already gone

    if (role.id === guild.id) {
      result.skipped.push({ id: role.id, type: 'role', reason: '@everyone' });
      return;
    }
    if (role.managed) {
      result.skipped.push({ id: role.id, type: 'role', reason: 'managed/integration role' });
      return;
    }
    if (role.position >= botHighestPosition) {
      result.skipped.push({ id: role.id, type: 'role', reason: 'above or equal to bot position' });
      return;
    }

    try {
      await deleteLimiter.run(() => role.delete('Anti-nuke: unauthorized role not present in blueprint'));
      result.deletedRoles.push(role.id);
    } catch (err) {
      result.skipped.push({ id: role.id, type: 'role', reason: `delete failed: ${err.message}` });
    }
  });

  const categoryTasks = diffResult.extraCategories.map(async (catData) => {
    const category = guild.channels.cache.get(catData.id);
    if (!category) return;

    if (!category.deletable) {
      result.skipped.push({ id: category.id, type: 'category', reason: 'not deletable by bot' });
      return;
    }

    try {
      await deleteLimiter.run(() => category.delete('Anti-nuke: unauthorized category not present in blueprint'));
      result.deletedCategories.push(category.id);
    } catch (err) {
      result.skipped.push({ id: category.id, type: 'category', reason: `delete failed: ${err.message}` });
    }
  });

  const channelTasks = diffResult.extraChannels.map(async (chanData) => {
    const channel = guild.channels.cache.get(chanData.id);
    if (!channel) return;

    if (!channel.deletable) {
      result.skipped.push({ id: channel.id, type: 'channel', reason: 'not deletable by bot' });
      return;
    }

    try {
      await deleteLimiter.run(() => channel.delete('Anti-nuke: unauthorized channel not present in blueprint'));
      result.deletedChannels.push(channel.id);
    } catch (err) {
      result.skipped.push({ id: channel.id, type: 'channel', reason: `delete failed: ${err.message}` });
    }
  });

  // Roles first (matches restoration ordering conventions), but categories
  // and channels can safely run alongside each other.
  await Promise.all(roleTasks);
  await Promise.all([...categoryTasks, ...channelTasks]);

  return result;
}

module.exports = cleanupUnknown;
