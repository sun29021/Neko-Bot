/**
 * NEKO Goal Manager
 *
 * WHAT THIS FILE DOES:
 * Runs the main autonomous "tick" loop - every few seconds it asks
 * GoalSelector what NEKO should do, then executes that goal using the
 * existing Goal.start()/execute()/complete()/fail() lifecycle already
 * built into core/Goal.js (so retry logic, timeouts, and event emission
 * all come for free).
 *
 * MANUAL OVERRIDE:
 * When a player asks NEKO to do something via chat (e.g. "mine some
 * iron"), we don't want the autonomous loop fighting that action by
 * immediately picking a different goal. pauseFor() lets the chat handler
 * (Phase 3) tell the goal manager "stay out of this for N seconds."
 */

import pathfinderPkg from 'mineflayer-pathfinder';
import goalSelector from './GoalSelector.js';
import logger from '../core/Logger.js';
import eventBus from '../core/EventBus.js';
import errorHandler from '../core/ErrorHandler.js';
import nekoBehavior from '../systems/Behavior.js';
import memory from '../memory/Memory.js';

const { goals: pathfinderGoals } = pathfinderPkg;

const TICK_INTERVAL = 5000; // how often to reconsider what to do

class GoalManager {
  constructor() {
    this.bot = null;
    this.playerState = null;
    this.tickHandle = null;
    this.currentGoal = null;
    this.running = false;
    this.pausedUntil = 0;
  }

  /**
   * Starts the autonomous loop. Call once after the bot spawns.
   */
  start(bot, playerState) {
    this.bot = bot;
    this.playerState = playerState;
    this.running = true;

    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = setInterval(() => this.tick(), TICK_INTERVAL);
    this.tickHandle.unref?.(); // don't block process exit

    logger.info('goals.manager_started', {});
  }

  stop() {
    this.running = false;
    if (this.tickHandle) clearInterval(this.tickHandle);
  }

  /**
   * Tells the goal manager to stand down for `ms` milliseconds - used
   * when a player manually requests an action via chat, so the
   * autonomous loop doesn't immediately interrupt it.
   */
  pauseFor(ms) {
    this.pausedUntil = Date.now() + ms;
  }

  /**
   * Single tick of the decision loop. Picks a goal and runs it to
   * completion (or failure). Goals are intentionally short (one craft,
   * one mining attempt, one explore hop) so the next tick can always
   * re-evaluate priorities - this is what lets a sudden zombie attack
   * interrupt a mining trip instead of NEKO ignoring it for minutes.
   */
  async tick() {
    if (!this.running || !this.bot?.entity) return;
    if (Date.now() < this.pausedUntil) return; // manual override active

    this.scanNearbyMobs();

    if (this.currentGoal && this.currentGoal.status === 'active') return; // still running

    try {
      const goal = goalSelector.selectNextGoal(this.playerState, this.bot);
      this.currentGoal = goal;

      const context = { bot: this.bot, pathfinderGoals, playerState: this.playerState };

      if (!(await goal.canExecute(context))) {
        return; // preconditions not met, try again next tick
      }

      await goal.start(context);
      await goal.execute(context);
      await goal.complete();

      // Small, steady confidence growth from successful goals - this is
      // separate from the bigger swings caused by near-death/flee events
      // (see memory.recordNearDeath, called from FleeGoal).
      if (goal.name !== 'flee' && goal.name !== 'eat') {
        memory.increaseConfidence(2);
      }
    } catch (err) {
      // Goal failures are expected sometimes (couldn't reach a block, no
      // materials yet) - log and let the next tick try something else
      // rather than crashing the whole bot.
      if (this.currentGoal) {
        await this.currentGoal.fail(err, false);
        memory.decreaseConfidence(3);
      }
      errorHandler.report(err, { context: 'goals.tick' });
      logger.warn('goals.tick_failed', { error: err.message });
    }
  }

  /**
   * Scans for hostile mobs within 16 blocks and updates PlayerState, which
   * emits 'combat.mobs_detected' on the EventBus - that's what lets
   * EventReactions.js (Phase 5) trigger NEKO commenting on danger in chat.
   */
  scanNearbyMobs() {
    const dangerousMobs = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'phantom', 'cave_spider'];
    const entities = Object.values(this.bot.entities || {});

    const nearby = entities
      .filter((e) => e.name && dangerousMobs.includes(e.name))
      .filter((e) => this.bot.entity.position.distanceTo(e.position) < 16)
      .map((e) => ({ name: e.name, distance: this.bot.entity.position.distanceTo(e.position) }));

    if (nearby.length > 0 || this.playerState.nearbyMobs.length > 0) {
      this.playerState.setNearbyMobs(nearby);
    }
  }

  /**
   * Used by the !status chat command and dashboard to show what's
   * currently happening.
   */
  getCurrentGoalInfo() {
    return this.currentGoal ? this.currentGoal.getInfo() : null;
  }
}

const goalManager = new GoalManager();
export default goalManager;
