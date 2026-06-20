/**
 * NEKO Bot v3.0 - Main Entry Point
 *
 * WHAT CHANGED FROM THE OLD VERSION:
 *  1. Config now comes from config.js (settings.json + env vars merged),
 *     instead of a hardcoded object duplicated here.
 *  2. The mineflayer-pathfinder plugin is actually loaded (it wasn't before -
 *     nothing in the old file used it, even though it's a dependency).
 *  3. Bot creation + event wiring is wrapped in a function so we can
 *     reconnect automatically if the bot disconnects, instead of just
 *     exiting the process.
 *  4. EventBus and ErrorHandler are now actually used (they existed before
 *     but nothing called them).
 *  5. Clearly marked extension points for Phase 2+ (memory, chat AI, goals,
 *     learning) so future phases just plug in here without touching the
 *     connection/reconnection logic.
 */

import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import collectBlockPkg from 'mineflayer-collectblock';
import autoEatPkg from 'mineflayer-auto-eat';
import express from 'express';

import config from './config.js';
import logger from './core/Logger.js';
import errorHandler from './core/ErrorHandler.js';
import eventBus from './core/EventBus.js';
import PlayerState from './core/PlayerState.js';
import memory from './memory/Memory.js';
import chatHandler from './chat/ChatHandler.js';
import goalManager from './ai/GoalManager.js';
import eventReactions from './systems/EventReactions.js';

const { pathfinder, Movements } = pathfinderPkg;
const { plugin: collectBlockPlugin } = collectBlockPkg;
const { plugin: autoEatPlugin } = autoEatPkg;

console.log(`🤖 Starting ${config.bot.name} Bot v3.0...`);
logger.info('bot.startup', { version: '3.0.0', server: config.server.host });

// ============================================================
// RECONNECTION STATE
// Tracks attempts so we can back off instead of hammering the
// server if it's down (important on a free host like Aternos).
// ============================================================
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60000; // cap backoff at 60s

let bot = null;
let playerState = null;

/**
 * Creates the bot, loads plugins, and wires up all event listeners.
 * Called once on startup, and again automatically after a disconnect.
 */
function createBot() {
  bot = mineflayer.createBot({
    host: config.server.host,
    port: config.server.port,
    username: config.account.username,
    version: config.server.version,
    auth: config.account.type === 'offline' ? undefined : 'microsoft'
  });

  // Load plugins:
  //  - pathfinder: navigation (already used by chat actions and goals)
  //  - collectblock: efficient "find+path+dig+pickup" for gathering wood
  //  - auto-eat: automatically eats food from inventory when hungry
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectBlockPlugin);
  bot.loadPlugin(autoEatPlugin);

  // PlayerState is a class - track the bot's own status (health, position,
  // inventory) in one consistent place instead of querying bot.* everywhere.
  playerState = new PlayerState(bot);

  // --------------------------------------------------------
  // CORE EVENT WIRING
  // --------------------------------------------------------

  bot.once('spawn', () => {
    reconnectAttempts = 0; // successful spawn resets the backoff counter

    // Configure default pathfinder movement profile now that the bot
    // knows what version/mcData it's working with.
    const mcData = bot.registry || bot.mcData;
    if (mcData) {
      const movements = new Movements(bot, mcData);
      bot.pathfinder.setMovements(movements);
    }

    logger.info('bot.spawned', { position: playerState.getPosition() });
    console.log('✅ Bot spawned in world!');

    eventBus.emit('bot.spawned', { position: playerState.getPosition() });

    // Load persistent memory now that we're connected. Doing this on
    // 'spawn' rather than at module load time means memory.data is ready
    // before any chat/goal logic (Phase 3+) tries to read it.
    if (!memory.loaded) {
      memory.load();
      memory.loaded = true;
      console.log(`🧠 Memory loaded: ${Object.keys(memory.data.players).length} known players, ${memory.getConfidenceLevel()}`);
    }

    // Start the autonomous goal-based AI loop (Phase 4). From this point
    // on, NEKO decides what to do on her own between chat interactions.
    goalManager.start(bot, playerState);
    console.log('🎯 Goal manager started - NEKO is now acting autonomously');

    // Wire real game events (damage, death, mob encounters) to NEKO's
    // reactive chat and the learning system (Phase 5).
    eventReactions.init(bot, playerState);

    // --------------------------------------------------------
    // EXTENSION POINT (Phase 5+): this is where the learning
    // system's pattern-analysis hooks will be attached.
    // --------------------------------------------------------
  });

  bot.on('login', () => {
    logger.info('bot.connected', { username: config.account.username });
    console.log('✅ Bot logged in!');
  });

  // Keep PlayerState in sync with the live bot whenever health changes.
  // (Position is synced on a tick-based loop added in a later phase,
  // since 'move' events fire far too often to log every time.)
  bot.on('health', () => {
    playerState.syncWithBot();
  });

  // Mineflayer's native 'death' event is the authoritative signal that
  // the bot died (more reliable than inferring it from health reaching
  // 0 via the health-sync above, which can race with respawn timing).
  bot.on('death', () => {
    eventBus.emit('player.death', {});
  });

  bot.on('kicked', (reason) => {
    logger.warn('bot.kicked', { reason });
    console.log('🚫 Kicked:', reason);
  });

  // --------------------------------------------------------
  // CHAT LISTENER (Phase 3)
  // Routes every player chat message through NEKO's chat handler.
  // Skips the bot's own messages to avoid talking to itself.
  // --------------------------------------------------------
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;

    try {
      const reply = await chatHandler.handlePlayerChat(username, message, bot);
      if (reply) {
        bot.chat(reply);
      }
    } catch (err) {
      errorHandler.report(err, { context: 'chat.handler', username });
    }
  });

  bot.on('error', (error) => {
    // Route through the central ErrorHandler instead of just console.log,
    // so connection errors get recorded and (eventually) trigger recovery
    // strategies like the 'CONNECTION_ERROR' one already defined there.
    errorHandler.report(error, { context: 'bot.connection' });
    console.log('❌ Error:', error.message);
  });

  bot.on('end', (reason) => {
    logger.warn('bot.disconnected', { reason });
    console.log('🔴 Bot disconnected:', reason || 'unknown reason');
    goalManager.stop();
    eventReactions.teardown();
    eventBus.emit('bot.disconnected', { reason });
    scheduleReconnect();
  });

  return bot;
}

/**
 * Reconnects with exponential backoff so we don't spam a downed server.
 * Delay sequence: 5s, 10s, 20s, 40s, 60s, 60s, 60s...
 */
function scheduleReconnect() {
  reconnectAttempts += 1;
  const delay = Math.min(5000 * 2 ** (reconnectAttempts - 1), MAX_RECONNECT_DELAY);

  logger.info('bot.reconnecting', { attempt: reconnectAttempts, delayMs: delay });
  console.log(`🔄 Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);

  setTimeout(() => {
    try {
      createBot();
    } catch (err) {
      errorHandler.report(err, { context: 'bot.reconnect' });
      scheduleReconnect();
    }
  }, delay);
}

// Start the bot for the first time
createBot();

// ============================================================
// WEB DASHBOARD
// Exposes /health for Railway's health checks + uptime monitors.
// ============================================================
const app = express();

app.get('/health', (req, res) => {
  res.json({
    status: bot?.entity ? 'connected' : 'disconnected',
    health: playerState?.health ?? null,
    position: playerState?.getPosition() ?? null,
    reconnectAttempts
  });
});

app.listen(config.dashboard.port, config.dashboard.host, () => {
  logger.info('dashboard.started', { port: config.dashboard.port });
  console.log(`📊 Dashboard at http://localhost:${config.dashboard.port}`);
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
process.on('SIGINT', () => {
  console.log('👋 Shutting down...');
  memory.save();
  bot?.quit();
  process.exit(0);
});

process.on('SIGTERM', () => {
  // Railway sends SIGTERM on redeploy/restart
  console.log('👋 Received SIGTERM, shutting down...');
  memory.save();
  bot?.quit();
  process.exit(0);
});

// Catch anything that slips through individual event handlers so the
// whole process doesn't crash on an unexpected error.
process.on('uncaughtException', (err) => {
  errorHandler.report(err, { context: 'process.uncaughtException' });
  console.error('💥 Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  errorHandler.report(reason instanceof Error ? reason : new Error(String(reason)), {
    context: 'process.unhandledRejection'
  });
  console.error('💥 Unhandled rejection:', reason);
});
