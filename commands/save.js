const WhitelistManager = require('../managers/WhitelistManager');
const BlueprintManager = require('../managers/BlueprintManager');

module.exports = {
  name: 'save',
  async execute(message) {
    if (!WhitelistManager.canManageWhitelist(message.author.id)) {
      return message.reply('Only the bot owner can run this command.');
    }

    await BlueprintManager.save(message.guild);
    return message.reply('Blueprint saved successfully. The owner of this server can use !log command');
  },
};
