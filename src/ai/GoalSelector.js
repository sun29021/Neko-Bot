/**
 * NEKO Goal Selector
 *
 * WHAT THIS FILE DOES:
 * This is the decision-making core of the "goal-based AI system" (spec
 * requirement #8). Every tick, the GoalManager (see GoalManager.js) asks
 * this selector "what should NEKO do right now?" and gets back a single
 * Goal instance to execute.
 *
 * DECISION ORDER (highest priority first):
 *  1. Survival - flee if in danger, eat if hungry. These ALWAYS win.
 *  2. Progression stage - based on what's in her inventory, figure out
 *     which "stage" of wood -> stone -> iron -> diamond she's at, and
 *     work toward the next stage.
 *  3. Explore - if there's nothing urgent to do, wander and discover.
 *
 * This stage-based approach is what makes NEKO "progress from wood tools
 * to the Ender Dragon naturally" (spec #27) without needing a human to
 * tell her each step - she always knows what tier she's missing and goes
 * to get it.
 */

import memory from '../memory/Memory.js';
import strategyAdaptor from '../systems/StrategyAdaptor.js';
import { EatGoal, FleeGoal } from './goals/SurvivalGoals.js';
import { AttackGoal } from './goals/CombatGoals.js';
import { GatherWoodGoal, CraftGoal, MineOreGoal, ExploreGoal, SmeltGoal } from './goals/ProgressionGoals.js';
import { BuildBaseGoal } from './goals/BuildBaseGoal.js';

// Tool tiers in progression order - this list IS the roadmap from wood to
// diamond. Nether/Ender Dragon prep is a documented next step (see roadmap
// at the end of this phase) since it needs portal-building and combat
// logic this phase doesn't cover yet.
const TOOL_TIERS = ['wooden', 'stone', 'iron', 'diamond'];

class GoalSelector {
  /**
   * Returns the single next Goal to execute, given current bot/player state.
   * @param {object} playerState - the bot's PlayerState instance
   * @param {object} bot - the live mineflayer bot (for entity/inventory checks)
   */
  selectNextGoal(playerState, bot) {
    // --------------------------------------------------------
    // 1. SURVIVAL CHECKS (always win)
    // --------------------------------------------------------
    if (playerState.isCriticalHealth()) {
      return new FleeGoal();
    }

    const threatMob = this.getNearestThreatMob(bot);
    if (threatMob) {
      // Use the learned per-mob strategy (StrategyAdaptor) to decide
      // fight or flee, instead of always fleeing. Creepers are always
      // handled as flee inside AttackGoal itself regardless of this
      // decision, for safety.
      const strategy = strategyAdaptor.getCombatStrategy(threatMob.name);
      return strategy.preferredTactic === 'engage' ? new AttackGoal() : new FleeGoal();
    }

    if (playerState.isStarving() && this.hasFood(bot)) {
      return new EatGoal();
    }

    // --------------------------------------------------------
    // 2. PROGRESSION STAGE
    // --------------------------------------------------------
    const stageGoal = this.getProgressionGoal(playerState, bot);
    if (stageGoal) return stageGoal;

    // --------------------------------------------------------
    // 3. NOTHING URGENT - EXPLORE
    // --------------------------------------------------------
    return new ExploreGoal();
  }

  /**
   * Returns the nearest dangerous mob within engagement range, or null.
   */
  getNearestThreatMob(bot) {
    if (!bot?.entity) return null;
    const dangerousMobs = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch'];
    const entities = Object.values(bot.entities || {});

    let nearest = null;
    let nearestDist = Infinity;
    for (const entity of entities) {
      if (!entity.name || !dangerousMobs.includes(entity.name)) continue;
      const dist = bot.entity.position.distanceTo(entity.position);
      if (dist < 8 && dist < nearestDist) {
        nearest = entity;
        nearestDist = dist;
      }
    }
    return nearest;
  }

  hasFood(bot) {
    if (!bot?.inventory) return false;
    const foodNames = ['bread', 'apple', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'carrot', 'potato'];
    return bot.inventory.items().some((item) => foodNames.includes(item.name));
  }

  /**
   * Figures out the next progression step based on inventory:
   * wood -> wooden tools -> stone -> stone tools -> iron -> iron tools -> diamond -> diamond tools
   */
  getProgressionGoal(playerState, bot) {
    const inv = playerState.inventory.items;
    const woodCount = inv.oak_log || inv.birch_log || inv.spruce_log || this.sumWoodLike(inv);
    const hasCraftingTable = (inv.crafting_table || 0) > 0;
    const hasPickaxe = (tier) => (inv[`${tier}_pickaxe`] || 0) > 0;
    const hasAxe = (tier) => (inv[`${tier}_axe`] || 0) > 0;

    // STAGE 0: no wood at all - go get some
    if (woodCount < 3) {
      return new GatherWoodGoal(5);
    }

    // STAGE 1: have wood, no crafting table - make one
    if (!hasCraftingTable) {
      return new CraftGoal('crafting_table', 6);
    }

    // STAGE 2: have table, no wooden pickaxe - make tools
    if (!hasPickaxe('wooden') && !hasPickaxe('stone') && !hasPickaxe('iron') && !hasPickaxe('diamond')) {
      return new CraftGoal('wooden_pickaxe', 6);
    }

    // STAGE 3: have wooden pickaxe, need stone -> mine some, then craft stone tools
    if (!hasPickaxe('stone') && !hasPickaxe('iron') && !hasPickaxe('diamond')) {
      const stoneCount = inv.cobblestone || 0;
      if (stoneCount < 3) {
        return new MineOreGoal('stone', 5);
      }
      return new CraftGoal('stone_pickaxe', 5);
    }

    // STAGE 3.5: have stone tools, no furnace yet -> craft one before
    // iron progression can smelt anything. Gated to the same condition
    // as the iron stage below, so this doesn't keep firing (and wasting
    // cobblestone) once NEKO already has iron/diamond tools.
    const hasFurnace = (inv.furnace || 0) > 0;
    if (!hasPickaxe('iron') && !hasPickaxe('diamond') && !hasFurnace && (inv.cobblestone || 0) >= 8) {
      return new CraftGoal('furnace', 5);
    }

    // STAGE 4: have stone tools, need iron -> mine raw iron, smelt it
    // into ingots, then craft iron tools. This was a gap in Phase 4: it
    // checked for iron_ingot but nothing produced one from raw_iron.
    if (!hasPickaxe('iron') && !hasPickaxe('diamond')) {
      const rawIron = inv.raw_iron || 0;
      const ironIngots = inv.iron_ingot || 0;

      if (ironIngots >= 3) {
        return new CraftGoal('iron_pickaxe', 5);
      }
      if (rawIron > 0) {
        return new SmeltGoal('raw_iron', 5);
      }
      return new MineOreGoal('iron', 5);
    }

    // STAGE 5: have iron tools - go for diamonds
    if (!hasPickaxe('diamond')) {
      const diamondCount = inv.diamond || 0;
      if (diamondCount < 3) {
        return new MineOreGoal('diamond', 5);
      }
      return new CraftGoal('diamond_pickaxe', 5);
    }

    // STAGE 6: has diamond tools, no base started yet, and has a surplus
    // of building material -> start a base.
    // SCOPE NOTE: because every earlier stage above returns early when its
    // condition isn't met, this only becomes reachable once full diamond
    // tools are done - NEKO secures survival tools completely before
    // settling down. A more interleaved "build a little along the way"
    // version is listed as a roadmap improvement rather than implemented
    // here, to keep this phase's logic easy to follow and test.
    if (!memory.data.base.location && (inv.cobblestone || 0) >= 16) {
      return new BuildBaseGoal();
    }

    // STAGE 7+: nothing more this phase defines - falls through to
    // ExploreGoal. Nether/End progression is documented in the roadmap
    // as future work, not implemented here.
    return null;
  }

  /**
   * Sums any inventory item whose name ends in _log or _planks, since
   * wood type varies (oak/birch/spruce/etc.)
   */
  sumWoodLike(items) {
    let total = 0;
    for (const [name, count] of Object.entries(items)) {
      if (name.endsWith('_log') || name.endsWith('_planks')) {
        total += count;
      }
    }
    return total;
  }
}

const goalSelector = new GoalSelector();
export default goalSelector;
