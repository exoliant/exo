const { ChannelType } = require('discord.js');
const PolicyManager = require('../managers/PolicyManager');

module.exports = {
  name: 'channelCreate',
  async execute(channel) {
    if (!channel.guild) return;

    const kind = channel.type === ChannelType.GuildCategory ? 'category' : 'channel';
    await PolicyManager.evaluate(channel.guild, kind, 'create', channel.id);
  },
};
