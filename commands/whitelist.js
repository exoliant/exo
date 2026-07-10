const WhitelistManager = require('../managers/WhitelistManager');

const VALID_ACTIONS = ['deleteChannel', 'deleteCategory', 'deleteRole', 'banMember', 'kickMember'];

/**
 * Usage:
 *   !whitelist grant @user deleteChannel                -> unrestricted for that action
 *   !whitelist grant @user deleteCategory 112233445566   -> restricted to one resource ID
 *   !whitelist revoke @user deleteRole
 *   !whitelist revoke @user deleteRole 998877665544
 *   !whitelist remove @user
 *   !whitelist list @user
 */
module.exports = {
  name: 'whitelist',
  async execute(message, args) {
    if (!WhitelistManager.canManageWhitelist(message.author.id)) {
      return message.reply('Only the bot owner can manage the whitelist.');
    }

    const [sub, userMention, action, resourceId] = args;
    const targetUser = message.mentions.users.first();
    const guildId = message.guild.id;

    if (!sub || (!targetUser && sub !== 'help')) {
      return message.reply(
        'Usage: `!whitelist <grant|revoke|remove|list> @user [action] [resourceId]`'
      );
    }

    switch (sub) {
      case 'grant': {
        if (!VALID_ACTIONS.includes(action)) {
          return message.reply(`Action must be one of: ${VALID_ACTIONS.join(', ')}`);
        }
        const entry = WhitelistManager.grant(guildId, targetUser.id, action, resourceId || null);
        return message.reply(
          resourceId
            ? `Granted \`${action}\` on resource \`${resourceId}\` to ${targetUser.tag}.`
            : `Granted unrestricted \`${action}\` to ${targetUser.tag}.\n\`\`\`${JSON.stringify(entry, null, 2)}\`\`\``
        );
      }

      case 'revoke': {
        if (!VALID_ACTIONS.includes(action)) {
          return message.reply(`Action must be one of: ${VALID_ACTIONS.join(', ')}`);
        }
        const ok = WhitelistManager.revoke(guildId, targetUser.id, action, resourceId || null);
        return message.reply(
          ok ? `Revoked \`${action}\`${resourceId ? ` for resource \`${resourceId}\`` : ''} from ${targetUser.tag}.`
             : `${targetUser.tag} had no \`${action}\` permission to revoke.`
        );
      }

      case 'remove': {
        const ok = WhitelistManager.removeUser(guildId, targetUser.id);
        return message.reply(
          ok ? `Removed ${targetUser.tag} from the whitelist entirely.`
             : `${targetUser.tag} was not on the whitelist.`
        );
      }

      case 'list': {
        const entry = WhitelistManager.getUserEntry(guildId, targetUser.id);
        return message.reply(
          entry
            ? `Permissions for ${targetUser.tag}:\n\`\`\`${JSON.stringify(entry, null, 2)}\`\`\``
            : `${targetUser.tag} has no whitelist entry (no permissions).`
        );
      }

      default:
        return message.reply('Unknown subcommand. Use grant, revoke, remove, or list.');
    }
  },
};
