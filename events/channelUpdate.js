const { ChannelType } = require('discord.js');
const PolicyManager = require('../managers/PolicyManager');
const { hasMeaningfulChannelChange } = require('../utils/compare');

module.exports = {
  name: 'channelUpdate',
  async execute(oldChannel, newChannel) {
    if (!newChannel.guild) return;

    // Cheap filter first: skip audit log / PolicyManager entirely if nothing
    // the blueprint actually tracks has changed (e.g. lastPinTimestamp churn).
    if (!hasMeaningfulChannelChange(oldChannel, newChannel)) return;

    const kind = newChannel.type === ChannelType.GuildCategory ? 'category' : 'channel';
    await PolicyManager.evaluate(newChannel.guild, kind, 'update', newChannel.id);
  },
};
