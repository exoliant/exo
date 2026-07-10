/**
 * Cheap equality checks for the specific fields the blueprint actually
 * tracks. Used by channelUpdate/roleUpdate handlers to skip Discord's
 * frequent no-op-for-us update events (e.g. lastPinTimestamp, lastMessageId)
 * before spending an audit log fetch and a PolicyManager evaluation on them.
 *
 * Deliberately NOT exhaustive - only fields BlueprintManager serializes are
 * worth comparing. If BlueprintManager starts tracking a new field, add the
 * matching comparison here too.
 */

function permissionOverwritesEqual(oldCollection, newCollection) {
  if (oldCollection.cache.size !== newCollection.cache.size) return false;

  for (const [id, newOw] of newCollection.cache) {
    const oldOw = oldCollection.cache.get(id);
    if (!oldOw) return false;
    if (oldOw.allow.bitfield !== newOw.allow.bitfield) return false;
    if (oldOw.deny.bitfield !== newOw.deny.bitfield) return false;
  }

  return true;
}

/**
 * @param {import('discord.js').GuildChannel} oldChannel
 * @param {import('discord.js').GuildChannel} newChannel
 * @returns {boolean} true if any blueprint-tracked field actually changed
 */
function hasMeaningfulChannelChange(oldChannel, newChannel) {
  if (oldChannel.name !== newChannel.name) return true;
  if (oldChannel.parentId !== newChannel.parentId) return true;
  if (oldChannel.position !== newChannel.position) return true;

  if ('topic' in newChannel && oldChannel.topic !== newChannel.topic) return true;
  if ('nsfw' in newChannel && oldChannel.nsfw !== newChannel.nsfw) return true;
  if ('rateLimitPerUser' in newChannel && oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
    return true;
  }
  if ('bitrate' in newChannel && oldChannel.bitrate !== newChannel.bitrate) return true;
  if ('userLimit' in newChannel && oldChannel.userLimit !== newChannel.userLimit) return true;

  if (!permissionOverwritesEqual(oldChannel.permissionOverwrites, newChannel.permissionOverwrites)) {
    return true;
  }

  return false;
}

/**
 * @param {import('discord.js').Role} oldRole
 * @param {import('discord.js').Role} newRole
 * @returns {boolean} true if any blueprint-tracked field actually changed
 */
function hasMeaningfulRoleChange(oldRole, newRole) {
  if (oldRole.name !== newRole.name) return true;
  if (oldRole.color !== newRole.color) return true;
  if (oldRole.hoist !== newRole.hoist) return true;
  if (oldRole.mentionable !== newRole.mentionable) return true;
  if (oldRole.position !== newRole.position) return true;
  if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) return true;
  if (oldRole.icon !== newRole.icon) return true; // detectable even though not restorable (see BlueprintManager)
  if (oldRole.unicodeEmoji !== newRole.unicodeEmoji) return true;

  return false;
}

module.exports = { hasMeaningfulChannelChange, hasMeaningfulRoleChange };
