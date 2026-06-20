/**
 * Progression Goals
 *
 * These are the goals that make NEKO "progress from wood tools to the
 * Ender Dragon naturally" (spec requirement #27). Each goal is small and
 * single-purpose; the GoalSelector chooses which one to run next based
 * on what NEKO currently has in her inventory (see GoalSelector.js for
 * the actual stage logic).
 *
 * All of these delegate the actual mechanics (finding blocks, pathing,
 * digging, crafting) to ../actions.js - this file is just orchestration
 * + progress/activity reporting, so there's no duplicate game-interaction
 * logic between this and the chat handler.
 */

import { Goal } from '../../core/Goal.js';
import * as actions from '../actions.js';
import nekoBehavior from '../../systems/Behavior.js';
import memory from '../../memory/Memory.js';
import strategyAdaptor from '../../systems/StrategyAdaptor.js';

// Blocks that strongly indicate a player-made or generated structure
// nearby (villages, dungeons) - used by ExploreGoal to flag points of
// interest worth remembering, without needing full structure-recognition
// data (which mineflayer doesn't expose directly).
const STRUCTURE_INDICATOR_BLOCKS = {
  chest: 'possible_structure',
  bed: 'village',
  bell: 'village',
  lectern: 'village',
  spawner: 'dungeon_or_mineshaft',
  end_portal_frame: 'stronghold'
};

// Ores where depth genuinely matters - shallow ores (coal, copper near
// surface) don't need Y-targeting, but diamond especially benefits from
// the learned-safe-depth logic in StrategyAdaptor.
const DEPTH_SENSITIVE_ORES = ['diamond', 'gold', 'redstone', 'iron'];

export class GatherWoodGoal extends Goal {
  constructor(amount = 5) {
    super('gather_wood', 4);
    this.amount = amount;
  }

  async execute({ bot }) {
    nekoBehavior.setActivity(`chopping wood 🪓 (need ${this.amount})`);
    this.setProgress(10);
    const result = await actions.gatherWood(bot, this.amount);
    this.setProgress(100);
    if (!result.success) {
      throw new Error(result.message);
    }
  }
}

export class CraftGoal extends Goal {
  constructor(itemName, priority = 4) {
    super(`craft_${itemName}`, priority);
    this.itemName = itemName;
  }

  async execute({ bot }) {
    nekoBehavior.setActivity(`crafting a ${this.itemName} 🔨`);
    this.setProgress(20);
    const result = await actions.craftItem(bot, this.itemName);
    this.setProgress(100);
    if (!result.success) {
      throw new Error(result.message);
    }
  }
}

export class MineOreGoal extends Goal {
  constructor(oreName, priority = 4) {
    super(`mine_${oreName}`, priority);
    this.oreName = oreName;
  }

  async execute({ bot }) {
    nekoBehavior.setActivity(`mining for ${this.oreName} ⛏️`);
    this.setProgress(10);

    const targetY = DEPTH_SENSITIVE_ORES.includes(this.oreName)
      ? strategyAdaptor.getMiningStrategy().targetYLevel
      : null;

    const result = await actions.mineOre(bot, this.oreName, 32, targetY);
    this.setProgress(100);
    if (!result.success) {
      // Not finding ore isn't a hard failure - it just means "explore more".
      // Don't throw for notFound, only throw for actual errors.
      if (!result.notFound) throw new Error(result.message);
    }
  }
}

/**
 * Wanders to a random nearby point to discover new terrain/structures.
 * This is what gives NEKO the "curious explorer" trait (spec #22) and
 * lets her stumble onto resources, villages, and biomes she'll remember
 * via memory.rememberLocation() (added once structure detection lands -
 * see roadmap).
 */
export class ExploreGoal extends Goal {
  constructor() {
    super('explore', 3);
  }

  async execute({ bot, pathfinderGoals }) {
    nekoBehavior.setActivity('exploring around 🧭');
    this.setProgress(10);

    // Check for nearby structure-indicator blocks BEFORE wandering off -
    // if NEKO is already near a village/dungeon, remember it now rather
    // than walking away from it.
    this.detectAndRememberStructures(bot);

    if (!bot.pathfinder) {
      this.setProgress(100);
      return;
    }

    // Pick a random point within ~40 blocks to wander to
    const angle = Math.random() * Math.PI * 2;
    const distance = 20 + Math.random() * 20;
    const targetX = bot.entity.position.x + Math.cos(angle) * distance;
    const targetZ = bot.entity.position.z + Math.sin(angle) * distance;

    try {
      await bot.pathfinder.goto(
        new pathfinderGoals.GoalNear(targetX, bot.entity.position.y, targetZ, 3)
      );
    } catch (err) {
      // Pathing might fail on tricky terrain - that's fine, not a hard error
    }

    // Check again after arriving - the new spot might reveal something new.
    this.detectAndRememberStructures(bot);

    this.setProgress(100);
  }

  /**
   * Scans nearby blocks for structure indicators (chests, beds, spawners,
   * etc.) and remembers their location via memory.rememberLocation() if
   * found and not already known. This is what gives NEKO the "explores
   * structures and biomes" / "remembers locations" traits (spec #24, #28).
   */
  detectAndRememberStructures(bot) {
    for (const [blockName, locationType] of Object.entries(STRUCTURE_INDICATOR_BLOCKS)) {
      try {
        const found = bot.findBlock({
          matching: (b) => b.name === blockName || b.name?.includes(blockName),
          maxDistance: 24
        });
        if (found) {
          const key = `${locationType}_${Math.floor(found.position.x / 50)}_${Math.floor(found.position.z / 50)}`;
          if (!memory.data.locations[key]) {
            memory.rememberLocation(key, found.position, locationType);
          }
        }
      } catch (err) {
        // findBlock can throw on some server/version edge cases - skip
        // this indicator and keep checking the others rather than
        // aborting the whole exploration goal.
      }
    }
  }
}

export class SmeltGoal extends Goal {
  constructor(rawItemName, priority = 5) {
    super(`smelt_${rawItemName}`, priority);
    this.rawItemName = rawItemName;
  }

  async execute({ bot }) {
    nekoBehavior.setActivity(`smelting ${this.rawItemName} 🔥`);
    this.setProgress(20);
    const result = await actions.smeltItem(bot, this.rawItemName);
    this.setProgress(100);
    if (!result.success) {
      throw new Error(result.message);
    }
  }
}

export default { GatherWoodGoal, CraftGoal, MineOreGoal, ExploreGoal, SmeltGoal };
