/**
 * NEKO Experience Recorder
 *
 * Records every significant event (mining, combat, crafting, exploration,
 * death) and provides pattern-detection over that history:
 *  - getDangerousYLevels(): Y-bands where NEKO has died 2+ times
 *  - getThreatRanking(): which mobs NEKO tends to flee from vs beat
 *
 * StrategyAdaptor.js consumes these to actually change NEKO's behavior
 * (mining depth, fight-or-flee choices) based on real past experience -
 * this is the "learning system" from spec requirement #9.
 *
 * Usage:
 *   experienceRecorder.record('mining', { ore: 'diamond', y: -54 })
 *   experienceRecorder.recordDeath({ position, cause: 'zombie' })
 *   experienceRecorder.getDangerousYLevels() // [{ yRangeStart: -48, deaths: 3 }]
 */

import logger from '../core/Logger.js';
import eventBus from '../core/EventBus.js';

class ExperienceRecorder {
  constructor() {
    this.events = []; // { category, data, timestamp }
    this.maxEvents = 1000; // keep memory bounded
  }

  /**
   * Records an experience event under a category.
   * Categories used elsewhere in the bot: 'mining', 'combat', 'exploration',
   * 'crafting', 'building', 'death'.
   */
  record(category, data = {}) {
    this.events.push({ category, data, timestamp: Date.now() });

    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    eventBus.emit('ai.learning_recorded', { category, data });
    logger.debug('experience.recorded', { category });
  }

  /**
   * Returns count of events in a category.
   */
  countByCategory(category) {
    return this.events.filter((e) => e.category === category).length;
  }

  /**
   * Records a death with positional context, used by getDeathPatterns()
   * to figure out where/how NEKO tends to die so StrategyAdaptor can
   * route around those conditions in the future.
   */
  recordDeath({ position, cause, nearbyMobs } = {}) {
    this.record('death', {
      y: position ? Math.floor(position.y) : null,
      cause: cause || 'unknown',
      nearbyMobs: nearbyMobs || []
    });
  }

  /**
   * Records the outcome of a combat encounter (fled vs engaged vs won)
   * against a specific mob type. This is what lets StrategyAdaptor's
   * combat strategy actually differ per mob instead of being one global
   * aggressiveness number.
   */
  recordCombatOutcome(mobType, outcome) {
    // outcome: 'fled' | 'engaged' | 'won'
    this.record('combat', { mobType, outcome });
  }

  /**
   * THE LEARNING LOGIC: analyzes past deaths to find dangerous Y-levels.
   * Returns Y-ranges (in 16-block bands) that have caused 2+ deaths,
   * sorted most-dangerous first. StrategyAdaptor uses this to steer
   * mining away from levels that have killed NEKO before.
   */
  getDangerousYLevels() {
    const deaths = this.events.filter((e) => e.category === 'death' && e.data.y !== null);
    const bandCounts = {};

    for (const death of deaths) {
      const band = Math.floor(death.data.y / 16) * 16; // group into 16-block bands
      bandCounts[band] = (bandCounts[band] || 0) + 1;
    }

    return Object.entries(bandCounts)
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([band, count]) => ({ yRangeStart: Number(band), deaths: count }));
  }

  /**
   * THE LEARNING LOGIC: analyzes past combat outcomes per mob type to
   * figure out which mobs NEKO tends to lose to (flees more than she
   * wins/engages). Returns mob names sorted most-threatening first.
   */
  getThreatRanking() {
    const combatEvents = this.events.filter((e) => e.category === 'combat' && e.data.mobType);
    const byMob = {};

    for (const event of combatEvents) {
      const mob = event.data.mobType;
      if (!byMob[mob]) byMob[mob] = { fled: 0, engaged: 0, won: 0 };
      if (byMob[mob][event.data.outcome] !== undefined) {
        byMob[mob][event.data.outcome] += 1;
      }
    }

    return Object.entries(byMob)
      .map(([mob, counts]) => {
        const total = counts.fled + counts.engaged + counts.won;
        const fleeRate = total > 0 ? counts.fled / total : 0;
        return { mob, ...counts, fleeRate };
      })
      .sort((a, b) => b.fleeRate - a.fleeRate);
  }

  /**
   * Returns summary stats used by the !knowledge chat command.
   */
  getStats() {
    return {
      totalEvents: this.events.length,
      miningEvents: this.countByCategory('mining'),
      combatEvents: this.countByCategory('combat'),
      explorationEvents: this.countByCategory('exploration'),
      craftingEvents: this.countByCategory('crafting'),
      deathEvents: this.countByCategory('death')
    };
  }

  /**
   * Returns the most recent N events, optionally filtered by category.
   * Useful for Phase 5's pattern-detection logic.
   */
  getRecent(count = 20, category = null) {
    const filtered = category ? this.events.filter((e) => e.category === category) : this.events;
    return filtered.slice(-count);
  }
}

const experienceRecorder = new ExperienceRecorder();
export default experienceRecorder;
