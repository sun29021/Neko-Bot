/**
 * NEKO Combat Goal
 *
 * Companion to FleeGoal (SurvivalGoals.js) - this is the "fight" half of
 * fight-or-flee. GoalSelector picks between AttackGoal and FleeGoal based
 * on StrategyAdaptor's learned per-mob strategy (see StrategyAdaptor.js).
 *
 * Keeps combat simple and safe: attacks the nearest threat with melee,
 * backing off automatically if health drops too low mid-fight (handing
 * control back to FleeGoal on the next tick rather than fighting to the
 * death).
 */

import { Goal } from '../../core/Goal.js';
import nekoBehavior from '../../systems/Behavior.js';
import experienceRecorder from '../../systems/ExperienceRecorder.js';

const DANGEROUS_MOBS = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'phantom', 'cave_spider'];
const MIN_SAFE_HEALTH = 8; // bail out of combat if health drops below this

export class AttackGoal extends Goal {
  constructor() {
    super('attack', 8); // high priority, just below flee/eat
  }

  async execute({ bot }) {
    const target = this.findNearestThreat(bot);
    if (!target) {
      this.setProgress(100);
      return;
    }

    nekoBehavior.setActivity(`fighting a ${target.name}! ⚔️`);
    this.setProgress(10);

    // CREEPER SAFETY: never melee a creeper at close range - that's how
    // players (and bots) lose their base to explosions. Treat creepers
    // as always-flee regardless of learned strategy.
    if (target.name === 'creeper') {
      experienceRecorder.recordCombatOutcome('creeper', 'fled');
      this.setProgress(100);
      return; // GoalSelector will pick FleeGoal next tick if still close
    }

    let swings = 0;
    const maxSwings = 6; // cap so one fight can't hang the tick loop forever

    while (swings < maxSwings) {
      if (bot.health <= MIN_SAFE_HEALTH) {
        experienceRecorder.recordCombatOutcome(target.name, 'fled');
        this.setProgress(100);
        return; // back off, let FleeGoal take over next tick
      }

      const current = bot.entities[target.id];
      if (!current || !current.isValid) {
        // target died or despawned - victory
        experienceRecorder.recordCombatOutcome(target.name, 'won');
        this.setProgress(100);
        return;
      }

      try {
        await bot.lookAt(current.position.offset(0, current.height ?? 1, 0));
        await bot.attack(current);
      } catch (err) {
        break; // attack failed (out of range, etc) - stop trying this tick
      }

      swings += 1;
      await new Promise((resolve) => setTimeout(resolve, 600)); // roughly one attack cooldown
    }

    // Ran out of swings this tick without a clear win/loss - record as
    // "engaged" (we fought, outcome inconclusive this tick) and let the
    // next tick re-evaluate.
    experienceRecorder.recordCombatOutcome(target.name, 'engaged');
    this.setProgress(100);
  }

  findNearestThreat(bot) {
    const entities = Object.values(bot.entities || {});
    let nearest = null;
    let nearestDist = Infinity;

    for (const entity of entities) {
      if (!entity.name || !DANGEROUS_MOBS.includes(entity.name)) continue;
      const dist = bot.entity.position.distanceTo(entity.position);
      if (dist < nearestDist && dist < 8) {
        nearest = entity;
        nearestDist = dist;
      }
    }

    return nearest;
  }
}

export default { AttackGoal };
