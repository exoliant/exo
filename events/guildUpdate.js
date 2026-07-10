const PolicyManager = require('../managers/PolicyManager');

module.exports = {
  name: 'guildUpdate',
  async execute(oldGuild, newGuild) {
    await PolicyManager.evaluate(newGuild, 'guild', 'update', newGuild.id);
  },
};
