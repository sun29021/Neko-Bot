/**
 * Survival Goals
 *
 * Highest-priority goals - these interrupt whatever NEKO is doing when
 * her health/hunger gets dangerous. The GoalSelector (see GoalSelector.js)
 * always checks survival conditions before anything else, which is what
 * makes NEKO "survive like a real player" (spec requirement #26) instead
 * of mining herself to death while ignoring a zombie on her back.
 */

import { Goal } from '../../core/Goal.js';
import memory from '../../memory/Memory.js';
import nekoBehavior from '../../systems/Behavior.js';
import experienceRecorder from '../../systems/ExperienceRecorder.js';

/**
 * Eats food from inventory when hunger is low. Relies on the
 * mineflayer-auto-eat plugin (loaded in index.js) to actually pick and
 * consume food - this goal just makes sure that plugin is enabled and
 * waits for it to do its job.
 */
export class EatGoal extends Goal {
  constructor() {
    super('eat', 9); // very high priority, just below fleeing for your life
  }

  async execute({ bot }) {
    nekoBehavior.setActivity('grabbing a snack 🍖');
    this.setProgress(20);

    if (!bot.autoEat) {
      // auto-eat plugin not loaded - nothing more we can do here
      this.setProgress(100);
      return;
    }

    // auto-eat handles the actual eating; we just give it a moment to act
    bot.autoEat.enableAuto();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    this.setProgress(100);
  }
}

/**
 * Runs away from danger (low health, dangerous mobs nearby).
 * Moves away from the nearest hostile entity rather than to a fixed point.
 */
export class FleeGoal extends Goal {
  constructor() {
    super('flee', 10); // absolute highest priority
  }

  async execute({ bot, pathfinderGoals }) {
    nekoBehavior.setActivity('running away! 🏃💨');
    memory.recordNearDeath();

    const threat = this.findNearestThreat(bot);
    if (!threat || !bot.pathfinder) {
      this.setProgress(100);
      return;
    }

    experienceRecorder.recordCombatOutcome(threat.name, 'fled');

    // Move to a point away from the threat
    const dx = bot.entity.position.x - threat.position.x;
    const dz = bot.entity.position.z - threat.position.z;
    const length = Math.hypot(dx, dz) || 1;
    const fleeX = bot.entity.position.x + (dx / length) * 10;
    const fleeZ = bot.entity.position.z + (dz / length) * 10;

    try {
      bot.pathfinder.setGoal(
        new pathfinderGoals.GoalNear(fleeX, bot.entity.position.y, fleeZ, 2)
      );
    } catch (err) {
      // best-effort - if pathing fails, at least we tried
    }

    this.setProgress(100);
  }

  findNearestThreat(bot) {
    const dangerousMobs = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'phantom'];
    const entities = Object.values(bot.entities || {});

    let nearest = null;
    let nearestDist = Infinity;

    for (const entity of entities) {
      if (!entity.name || !dangerousMobs.includes(entity.name)) continue;
      const dist = bot.entity.position.distanceTo(entity.position);
      if (dist < nearestDist) {
        nearest = entity;
        nearestDist = dist;
      }
    }

    return nearest;
  }
}

export default { EatGoal, FleeGoal };
