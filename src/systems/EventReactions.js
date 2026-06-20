/**
 * NEKO Event Reactions
 *
 * BUG FIX FROM PHASE 3: chatHandler.analyzeGameEvent() was built to react
 * to game events in chat, but nothing ever called it - it was dead code.
 * This file is the missing wiring: it listens on the EventBus for real
 * gameplay events and routes them through analyzeGameEvent(), then
 * actually sends the resulting message to chat.
 *
 * This also feeds the learning system: every death and combat encounter
 * gets recorded via ExperienceRecorder so StrategyAdaptor can learn from
 * it (see ExperienceRecorder.getDangerousYLevels() / getThreatRanking()).
 *
 * Usage (called once from index.js after the bot spawns):
 *   import eventReactions from './systems/EventReactions.js'
 *   eventReactions.init(bot, playerState)
 */

import eventBus from '../core/EventBus.js';
import logger from '../core/Logger.js';
import memory from '../memory/Memory.js';
import chatHandler from '../chat/ChatHandler.js';
import experienceRecorder from './ExperienceRecorder.js';

class EventReactions {
  constructor() {
    this.initialized = false;
    this.unsubscribers = [];
  }

  /**
   * Wires up all the EventBus listeners. Safe to call once per bot
   * connection - call teardown() first if reconnecting.
   */
  init(bot, playerState) {
    if (this.initialized) this.teardown();

    this.bot = bot;
    this.playerState = playerState;

    this.unsubscribers.push(
      eventBus.on('player.damaged', (data) => this.handleDamage(data)),
      eventBus.on('player.death', (data) => this.handleDeath(data)),
      eventBus.on('combat.mobs_detected', (data) => this.handleMobsDetected(data))
    );

    this.initialized = true;
    logger.info('event_reactions.initialized', {});
  }

  teardown() {
    this.unsubscribers.forEach((unsub) => unsub());
    this.unsubscribers = [];
    this.initialized = false;
  }

  /**
   * Sends a chat reaction if analyzeGameEvent() decides one is warranted,
   * with consistent error handling so a chat failure never crashes the bot.
   */
  async react(eventType, data) {
    try {
      const result = await chatHandler.analyzeGameEvent({ type: eventType, data });
      if (result.shouldChat && this.bot?.chat) {
        this.bot.chat(result.message);
      }
    } catch (err) {
      logger.warn('event_reactions.react_failed', { eventType, error: err.message });
    }
  }

  handleDamage(data) {
    this.react('damage', { health: this.playerState.health, damage: data.damage });
  }

  handleDeath() {
    const position = this.playerState?.getPosition();
    experienceRecorder.recordDeath({ position, nearbyMobs: this.playerState?.nearbyMobs || [] });
    this.react('death', { position });
  }

  handleMobsDetected(data) {
    if (!data.mobs || data.mobs.length === 0) return;
    this.react('mob_encounter', { mobs: data.mobs });
  }
}

const eventReactions = new EventReactions();
export default eventReactions;
