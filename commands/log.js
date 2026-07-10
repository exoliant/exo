const { ChannelType } = require('discord.js');
const LogManager = require('../managers/LogManager');

/**
 * Usage: !log {channel_id}
 * Also accepts a channel mention (#some-channel), not just a raw ID.
 *
 * Restricted to the SERVER owner (guild.ownerId) - deliberately different
 * from !save/!whitelist, which are restricted to the single global bot
 * owner (config.ownerId). Log channel configuration is a per-server
 * preference, so it makes sense for each server's own owner to control it.
 */
module.exports = {
  name: 'log',
  async execute(message, args) {
    if (message.guild.ownerId !== message.author.id) {
      return message.reply('Only this server\'s owner can set the log channel.');
    }

    const rawInput = args[0];
    if (!rawInput) {
      return message.reply('Usage: `!log {channel_id}` (or mention the channel, e.g. `!log #mod-logs`)');
    }

    const channelId = rawInput.replace(/[<#>]/g, '');
    const channel = message.guild.channels.cache.get(channelId);

    if (!channel) {
      return message.reply("I can't find a channel with that ID in this server.");
    }

    if (channel.type !== ChannelType.GuildText) {
      return message.reply('The log channel must be a text channel.');
    }

    LogManager.setLogChannel(message.guild.id, channel.id, channel.name);
    return message.reply(`Log channel set to ${channel}. Anti-nuke alerts will be posted there.`);
  },
};
