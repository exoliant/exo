const PolicyManager = require('../managers/PolicyManager');

module.exports = {
  name: 'guildMemberRemove',
  async execute(member) {
    // This fires for voluntary leaves, kicks, AND bans. We only care about
    // kicks here - bans are handled by guildBanAdd. PolicyManager resolves
    // this specifically against MemberKick audit entries, so leaves and
    // bans naturally resolve to null (no matching kick entry) and are
    // ignored without any special-casing needed here.
    await PolicyManager.evaluateMemberAction(member.guild, 'kick', member.id);
  },
};
