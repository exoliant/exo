const PolicyManager = require('../managers/PolicyManager');

module.exports = {
  name: 'roleCreate',
  async execute(role) {
    await PolicyManager.evaluate(role.guild, 'role', 'create', role.id);
  },
};
