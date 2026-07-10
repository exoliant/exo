const PolicyManager = require('../managers/PolicyManager');
const { ChannelType } = require('discord.js');

module.exports = {
  name: 'channelDelete',
  async execute(channel) {
    if (!channel.guild) return;

    const isCategory = channel.type === ChannelType.GuildCategory;
    const kind = isCategory ? 'category' : 'channel';
    const extra = isCategory ? { childChannelCount: channel.children?.cache?.size ?? 0 } : {};

    await PolicyManager.evaluate(channel.guild, kind, 'delete', channel.id, extra);
  },
};
