const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, Collection } = require('discord.js');

const config = require('./config');
const { ensureDataDirectories } = require('./utils/file');

// Fail fast with a clear message if required env vars are missing/invalid,
// rather than surfacing as a confusing discord.js login error later.
config.validate();

// Make sure data/blueprints, data/whitelist, data/cache, data/logs, and temp/
// all exist before anything tries to read/write to them.
ensureDataDirectories(__dirname);

// Started before the Discord client so free-hosting platforms see HTTP
// activity immediately, even if login is slow. Purely infrastructure -
// see utils/keepAlive.js for why this exists and how to disable it.
if (config.keepAliveEnabled) {
  const { startKeepAlive } = require('./utils/keepAlive');
  startKeepAlive();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged - required for member fetch/ban and rank checks
    GatewayIntentBits.GuildModeration, // required to receive guildBanAdd events
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged - required to read prefix command text
  ],
});

client.commands = new Collection();

/**
 * Loads every file in commands/ and registers it by its exported `name`.
 * Adding a new command later is just dropping another file in that folder.
 */
function loadCommands() {
  const commandsDir = path.join(__dirname, 'commands');
  const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));

  for (const file of files) {
    const command = require(path.join(commandsDir, file));
    if (!command.name || typeof command.execute !== 'function') {
      console.warn(`[Bootstrap] Skipping invalid command file: ${file}`);
      continue;
    }
    client.commands.set(command.name, command);
  }

  return client.commands.size;
}

/**
 * Loads every file in events/ and wires it to the client. A module can
 * export `once: true` (e.g. ready.js) to use client.once instead of client.on.
 */
function loadEvents() {
  const eventsDir = path.join(__dirname, 'events');
  const files = fs.readdirSync(eventsDir).filter((f) => f.endsWith('.js'));
  let count = 0;

  for (const file of files) {
    const event = require(path.join(eventsDir, file));
    if (!event.name || typeof event.execute !== 'function') {
      console.warn(`[Bootstrap] Skipping invalid event file: ${file}`);
      continue;
    }

    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args));
    } else {
      client.on(event.name, (...args) => event.execute(...args));
    }
    count++;
  }

  return count;
}

client.commandCount = loadCommands();
client.eventCount = loadEvents();

client.login(config.token).catch((err) => {
  console.error('[Bootstrap] Failed to log in:', err);
  process.exit(1);
});
