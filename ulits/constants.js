const { AuditLogEvent } = require('discord.js');

/**
 * Maps {kind, action} -> the discord.js AuditLogEvent enum value to search
 * for when attributing that event. Centralized here so adding a new
 * protected resource type (webhooks, emojis, stickers, automod rules) is a
 * one-line addition instead of a change scattered across managers.
 */
const AUDIT_EVENT_MAP = {
  channel: {
    create: AuditLogEvent.ChannelCreate,
    update: AuditLogEvent.ChannelUpdate,
    delete: AuditLogEvent.ChannelDelete,
  },
  category: {
    create: AuditLogEvent.ChannelCreate,
    update: AuditLogEvent.ChannelUpdate,
    delete: AuditLogEvent.ChannelDelete,
  },
  role: {
    create: AuditLogEvent.RoleCreate,
    update: AuditLogEvent.RoleUpdate,
    delete: AuditLogEvent.RoleDelete,
  },
  guild: {
    update: AuditLogEvent.GuildUpdate,
  },
};

function getAuditEventType(kind, action) {
  return AUDIT_EVENT_MAP[kind]?.[action] ?? null;
}

/**
 * Ban/kick don't fit the {kind, action} = {channel/role/guild, create/update/delete}
 * vocabulary above - they're member-targeted actions, not structural changes.
 * Kept as a separate small map for clarity.
 */
const MEMBER_AUDIT_EVENT_MAP = {
  ban: AuditLogEvent.MemberBanAdd,
  kick: AuditLogEvent.MemberKick,
};

function getMemberAuditEventType(kind) {
  return MEMBER_AUDIT_EVENT_MAP[kind] ?? null;
}

/**
 * Builds the whitelist permission key for a given kind+action, e.g.
 * ("channel", "delete") -> "deleteChannel", ("role", "create") -> "createRole".
 */
function buildWhitelistActionKey(kind, action) {
  const capitalized = kind.charAt(0).toUpperCase() + kind.slice(1);
  return `${action}${capitalized}`;
}

module.exports = {
  AUDIT_EVENT_MAP,
  getAuditEventType,
  buildWhitelistActionKey,
  MEMBER_AUDIT_EVENT_MAP,
  getMemberAuditEventType,
};
