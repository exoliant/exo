/**
 * All current commands (!save, !whitelist) are message-based - see
 * messageCreate.js. This handler exists so the event-loading convention
 * covers interactions too, ready for slash commands later. It's currently
 * a no-op for chat input commands because client.commands entries expect
 * a (message, args) signature, not an interaction - wiring this up for
 * real slash-command dispatch requires either separate slash-command
 * modules or an adapter, not just calling command.execute(interaction).
 */
module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {
    if (!interaction.isChatInputCommand()) return;

    console.warn(
      `[interactionCreate] Received slash command "${interaction.commandName}" but no slash commands are registered yet.`
    );
    await interaction
      .reply({ content: 'Slash commands are not yet supported - use prefix commands instead.', ephemeral: true })
      .catch(() => {});
  },
};
