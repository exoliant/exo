const PolicyManager = require('../managers/PolicyManager');

module.exports = {
  name: 'guildBanAdd',
  async execute(ban) {
    await PolicyManager.evaluateMemberAction(ban.guild, 'ban', ban.user.id);
  },
};
