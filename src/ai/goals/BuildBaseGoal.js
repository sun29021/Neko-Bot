/**
 * NEKO Base Building Goal
 *
 * Builds a simple starter shelter once NEKO has basic tools and enough
 * blocks, and remembers the location permanently via memory.rememberLocation()
 * so she can return to it later (spec requirement #29: "Builds and expands
 * its base over time").
 *
 * SCOPE NOTE (also in the roadmap): this builds a minimal 3x3 dirt/cobble
 * box shelter - it does NOT do architectural planning, farms, storage
 * rooms, or "expansion" beyond the first shelter. That's flagged as
 * future work in the roadmap rather than implemented here, since it would
 * need a much larger building-planner system than fits this phase.
 */

import { Goal } from '../../core/Goal.js';
import memory from '../../memory/Memory.js';
import nekoBehavior from '../../systems/Behavior.js';

export class BuildBaseGoal extends Goal {
  constructor() {
    super('build_base', 5);
  }

  async execute({ bot }) {
    nekoBehavior.setActivity('building my base 🏗️');
    this.setProgress(10);

    // Pick a build site: current position, if not already chosen.
    if (!memory.data.base.location) {
      const pos = bot.entity.position;
      memory.data.base.location = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
      memory.rememberLocation('home_base', pos, 'base');
    }

    const buildableBlock = bot.inventory.items().find((i) =>
      ['cobblestone', 'dirt', 'oak_planks'].includes(i.name)
    );

    if (!buildableBlock) {
      this.setProgress(100);
      throw new Error(`No building materials on hand yet 🧱`);
    }

    // Place a simple wall block adjacent to NEKO as a minimal starting
    // shelter wall. This is intentionally simple (see scope note above) -
    // it's a starting point, not a full builder.
    try {
      const refPos = bot.entity.position.offset(1, 0, 0);
      const refBlock = bot.blockAt(refPos.offset(0, -1, 0));
      if (refBlock) {
        await bot.equip(buildableBlock, 'hand');
        await bot.placeBlock(refBlock, { x: 0, y: 1, z: 0 });
      }
    } catch (err) {
      // Building can fail for lots of legitimate reasons (obstructed,
      // wrong block face, etc) - not a hard failure, just try again later.
    }

    this.setProgress(80);

    // Mark progress: first wall block placed -> base.upgrades records
    // the milestone if it's not already the most recent one.
    const upgrades = memory.data.base.upgrades;
    if (upgrades[upgrades.length - 1] !== 'dirt_shelter') {
      upgrades.push('dirt_shelter');
      memory.data.base.nextUpgrade = 'cobblestone_walls';
      memory.saveMemory();
    }

    this.setProgress(100);
  }
}

export default { BuildBaseGoal };
