const PolicyManager = require('../managers/PolicyManager');
const { hasMeaningfulRoleChange } = require('../utils/compare');

module.exports = {
  name: 'roleUpdate',
  async execute(oldRole, newRole) {
    if (!hasMeaningfulRoleChange(oldRole, newRole)) return;

    await PolicyManager.evaluate(newRole.guild, 'role', 'update', newRole.id);
  },
};
