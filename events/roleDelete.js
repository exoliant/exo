const PolicyManager = require('../managers/PolicyManager');

module.exports = {
  name: 'roleDelete',
  async execute(role) {
    await PolicyManager.evaluate(role.guild, 'role', 'delete', role.id);
  },
};
