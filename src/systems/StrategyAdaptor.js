/**
 * NEKO Strategy Adaptor
 *
 * This is where "learning" actually changes behavior. Confidence level
 * still plays a role (it reflects general morale), but the real
 * adaptation now comes from ExperienceRecorder's pattern detection:
 *  - Mining avoids Y-levels that have killed NEKO multiple times before
 *  - Combat aggressiveness is now PER-MOB, based on actual flee/win history,
 *    instead of one global number
 *
 * Public API is unchanged from Phase 3 (getAdaptationReport,
 * getMiningStrategy, getCombatStrategy) so the chat handler's !learn and
 * !strategy commands didn't need any changes for this upgrade.
 */

import memory from '../memory/Memory.js';
import experienceRecorder from './ExperienceRecorder.js';

// Diamonds are most common around Y -54 in 1.18+ terrain. This is the
// "ideal" depth we'll mine at unless experience says otherwise.
const IDEAL_DIAMOND_Y = -54;
const SAFE_FALLBACK_Y = 12; // shallower, much safer general mining depth

class StrategyAdaptor {
  /**
   * Used by the !learn chat command.
   */
  getAdaptationReport() {
    const confidence = memory.data.confidenceLevel;
    return {
      adaptationLevel: Math.round(confidence / 10),
      knownDangerousMobs: experienceRecorder.getThreatRanking().filter((m) => m.fleeRate > 0.5).length,
      knownSafeZones: Object.keys(memory.data.locations).length,
      dangerousYLevels: experienceRecorder.getDangerousYLevels().length
    };
  }

  /**
   * Used by the !strategy chat command and by MineOreGoal to decide what
   * Y-level to dig at. Now actually avoids levels that have killed NEKO
   * multiple times, falling back to a shallower, safer depth instead.
   */
  getMiningStrategy() {
    const confidence = memory.data.confidenceLevel;
    const dangerousLevels = experienceRecorder.getDangerousYLevels();

    let targetYLevel = confidence > 50 ? IDEAL_DIAMOND_Y : SAFE_FALLBACK_Y;

    // If the ideal depth falls inside a known-dangerous 16-block band,
    // back off to the safer fallback depth instead.
    const idealBand = Math.floor(IDEAL_DIAMOND_Y / 16) * 16;
    const idealIsDangerous = dangerousLevels.some((d) => d.yRangeStart === idealBand);
    if (idealIsDangerous) {
      targetYLevel = SAFE_FALLBACK_Y;
    }

    return {
      targetYLevel,
      cautious: confidence <= 50 || idealIsDangerous,
      avoidedDangerZone: idealIsDangerous
    };
  }

  /**
   * Used by the !strategy chat command and combat decisions to decide
   * fight-or-flee behavior. Now checks per-mob history first - if NEKO
   * has fled from creepers 80% of the time, she'll keep fleeing from
   * creepers specifically even if her overall confidence is high.
   */
  getCombatStrategy(mobType = null) {
    const confidence = memory.data.confidenceLevel;

    if (mobType) {
      const ranking = experienceRecorder.getThreatRanking();
      const known = ranking.find((m) => m.mob === mobType);
      if (known && known.fleeRate > 0.6) {
        return { preferredTactic: 'evade', aggressiveness: Math.round((1 - known.fleeRate) * 10), reason: 'learned_threat' };
      }
    }

    return {
      preferredTactic: confidence > 60 ? 'engage' : 'evade',
      aggressiveness: Math.round(confidence / 10),
      reason: 'confidence_based'
    };
  }

  /**
   * Full per-mob threat breakdown, used by deeper status/debugging
   * commands and available for future combat-goal logic.
   */
  getThreatBreakdown() {
    return experienceRecorder.getThreatRanking();
  }
}

const strategyAdaptor = new StrategyAdaptor();
export default strategyAdaptor;
