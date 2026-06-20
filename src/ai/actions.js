/**
 * NEKO Shared Actions
 *
 * WHY THIS FILE EXISTS:
 * Both the chat handler (when a player types "mine some iron") and the
 * autonomous goal system (when NEKO decides on her own to mine iron) need
 * to do the exact same thing: find the block, path to it, dig it. Without
 * this file, that logic would be written twice and drift out of sync as
 * the bot gets more features. This is the SINGLE place that logic lives.
 *
 * Every function here takes `bot` as its first argument and returns a
 * small result object: { success: boolean, message: string, ...extra }
 * so callers (chat replies, goal progress, logging) can all consume it
 * the same way.
 */

import minecraftData from 'minecraft-data';
import pathfinderPkg from 'mineflayer-pathfinder';
import memory from '../memory/Memory.js';
import experienceRecorder from '../systems/ExperienceRecorder.js';
import logger from '../core/Logger.js';

const { goals } = pathfinderPkg;

const ORE_ALIASES = {
  iron: 'iron_ore', gold: 'gold_ore', diamond: 'diamond_ore',
  coal: 'coal_ore', emerald: 'emerald_ore', lapis: 'lapis_lazuli_ore',
  redstone: 'redstone_ore', copper: 'copper_ore'
};

const LOG_TYPES = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log'];

/**
 * Crafts one item, walking to a crafting table first if one is needed
 * and one is nearby. Returns { success, message }.
 */
export async function craftItem(bot, itemNameRaw) {
  const itemName = itemNameRaw.replace(/\s+/g, '_');
  if (!itemName) return { success: false, message: `I don't know what to craft.` };

  let mcData;
  try {
    mcData = minecraftData(bot.version);
  } catch (e) {
    return { success: false, message: `Can't access game data right now 😅` };
  }

  const item = mcData.itemsByName[itemName];
  if (!item) {
    return { success: false, message: `I don't know what "${itemNameRaw}" is 🤔` };
  }

  const craftingTableBlock = bot.findBlock
    ? bot.findBlock({ matching: mcData.blocksByName.crafting_table?.id, maxDistance: 16 })
    : null;

  let recipes = bot.recipesFor(item.id, null, 1, craftingTableBlock || null);
  if ((!recipes || recipes.length === 0) && craftingTableBlock) {
    recipes = bot.recipesFor(item.id, null, 1, null);
  }

  if (!recipes || recipes.length === 0) {
    return {
      success: false,
      message: `I don't have the materials${craftingTableBlock ? '' : ' (or a crafting table nearby)'} to make ${itemNameRaw} yet 😕`
    };
  }

  try {
    if (craftingTableBlock && bot.pathfinder) {
      await bot.pathfinder
        .goto(new goals.GoalNear(craftingTableBlock.position.x, craftingTableBlock.position.y, craftingTableBlock.position.z, 2))
        .catch(() => {});
    }
    await bot.craft(recipes[0], 1, craftingTableBlock || null);
    experienceRecorder.record('crafting', { item: itemNameRaw });
    return { success: true, message: `Crafted ${itemNameRaw}! ✅🔨` };
  } catch (err) {
    logger.warn('action.craft_failed', { item: itemNameRaw, error: err.message });
    return { success: false, message: `Tried to craft ${itemNameRaw} but something went wrong: ${err.message}` };
  }
}

/**
 * Finds and mines one block of a given ore type. Returns { success, message }.
 * @param {number|null} targetY - if given, prefers blocks near this Y-level
 *   (from StrategyAdaptor's learned-safe depth) before falling back to any
 *   matching block in range.
 */
export async function mineOre(bot, oreNameRaw, maxDistance = 32, targetY = null) {
  const key = oreNameRaw.replace(/\s+/g, '_');
  const oreType = ORE_ALIASES[oreNameRaw] || (key.endsWith('_ore') ? key : `${key}_ore`);

  let mcData;
  try {
    mcData = minecraftData(bot.version);
  } catch (e) {
    return { success: false, message: `Can't access game data right now 😅` };
  }
  if (!mcData.blocksByName[oreType]) {
    return { success: false, message: `I don't recognize "${oreNameRaw}" as something I can mine 🤔` };
  }

  const oreId = mcData.blocksByName[oreType].id;
  let block = null;

  // If we have a learned-safe target depth, first look for ore within
  // 16 blocks of it - only fall back to "anywhere in range" if nothing
  // is found near the preferred depth.
  if (targetY !== null) {
    block = bot.findBlock({
      matching: (b) => b.type === oreId && Math.abs(b.position.y - targetY) <= 16,
      maxDistance
    });
  }
  if (!block) {
    block = bot.findBlock({ matching: oreId, maxDistance });
  }

  if (!block) {
    return { success: false, message: `Don't see any ${oreNameRaw} nearby, I'll keep an eye out 👀`, notFound: true };
  }

  try {
    await bot.pathfinder.goto(new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z));
    await bot.dig(block);
    memory.collectItem(oreType, 1);
    experienceRecorder.record('mining', { ore: oreType, quantity: 1, y: Math.floor(block.position.y) });
    return { success: true, message: `Mined ${oreNameRaw}! ⛏️`, ore: oreType };
  } catch (err) {
    logger.warn('action.mine_failed', { ore: oreType, error: err.message });
    return { success: false, message: `Found ${oreNameRaw} but couldn't get to it: ${err.message}` };
  }
}

/**
 * Chops down nearby trees until `count` logs are collected (or none left
 * nearby). Uses mineflayer-collectblock if available for efficient
 * pathing+digging+pickup; falls back to manual dig if not.
 */
export async function gatherWood(bot, count = 5, maxDistance = 32) {
  let mcData;
  try {
    mcData = minecraftData(bot.version);
  } catch (e) {
    return { success: false, message: `Can't access game data right now 😅` };
  }

  const logIds = LOG_TYPES.map((name) => mcData.blocksByName[name]?.id).filter(Boolean);
  let collected = 0;

  for (let i = 0; i < count; i++) {
    const block = bot.findBlock({ matching: (b) => logIds.includes(b.type), maxDistance });
    if (!block) break;

    try {
      if (bot.collectBlock) {
        await bot.collectBlock.collect(block);
      } else {
        await bot.pathfinder.goto(new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z));
        await bot.dig(block);
      }
      memory.collectItem('wood', 1);
      experienceRecorder.record('mining', { ore: 'wood', quantity: 1 });
      collected += 1;
    } catch (err) {
      logger.warn('action.gather_wood_failed', { error: err.message });
      break;
    }
  }

  if (collected === 0) {
    return { success: false, message: `No trees nearby to chop 🌲`, notFound: true };
  }

  return { success: true, message: `Chopped ${collected} logs! 🪓`, collected };
}

/**
 * Walks to a player's current position.
 */
export async function comeToPlayer(bot, playerName) {
  const player = bot.players[playerName]?.entity;
  if (!player) return { success: false, message: `I can't see you right now 🤔 get closer?` };
  if (!bot.pathfinder) return { success: false, message: `My pathfinder isn't ready yet, give me a sec.` };

  bot.pathfinder.setGoal(new goals.GoalNear(player.position.x, player.position.y, player.position.z, 2));
  return { success: true, message: `On my way! 🏃` };
}

/**
 * Smelts raw ore into ingots using a nearby furnace (placing one from
 * inventory if needed and one isn't found). This was a gap flagged in
 * earlier phases: the iron-tool progression stage checked for
 * iron_ingot in inventory, but nothing actually produced it until now.
 */
export async function smeltItem(bot, rawItemName, fuelItemName = 'coal') {
  let mcData;
  try {
    mcData = minecraftData(bot.version);
  } catch (e) {
    return { success: false, message: `Can't access game data right now 😅` };
  }

  const rawItem = mcData.itemsByName[rawItemName];
  const fuelItem = mcData.itemsByName[fuelItemName];
  if (!rawItem) return { success: false, message: `I don't know how to smelt "${rawItemName}" 🤔` };

  // Find a furnace nearby, or place one from inventory if we're carrying one.
  let furnaceBlock = bot.findBlock({ matching: mcData.blocksByName.furnace?.id, maxDistance: 16 });

  if (!furnaceBlock) {
    const furnaceItem = bot.inventory.items().find((i) => i.name === 'furnace');
    if (!furnaceItem) {
      return { success: false, message: `Need a furnace to smelt this - don't have one or materials to make one 😕` };
    }
    try {
      const refBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0));
      await bot.equip(furnaceItem, 'hand');
      await bot.placeBlock(refBlock, { x: 0, y: 1, z: 0 });
      furnaceBlock = bot.findBlock({ matching: mcData.blocksByName.furnace?.id, maxDistance: 16 });
    } catch (err) {
      return { success: false, message: `Tried to place a furnace but couldn't: ${err.message}` };
    }
  }

  if (!furnaceBlock) {
    return { success: false, message: `Still no furnace to smelt with 😕` };
  }

  try {
    await bot.pathfinder.goto(new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2));
    const furnace = await bot.openFurnace(furnaceBlock);

    const rawInInventory = bot.inventory.items().find((i) => i.name === rawItemName);
    const fuelInInventory = fuelItem ? bot.inventory.items().find((i) => i.name === fuelItemName) : null;

    if (!rawInInventory) {
      furnace.close();
      return { success: false, message: `Don't have any raw ${rawItemName} to smelt 😕` };
    }
    if (fuelItem && fuelInInventory) {
      await furnace.putFuel(fuelItem.id, null, 1);
    }
    await furnace.putInput(rawItem.id, null, 1);

    // Wait for one smelt cycle (~10s vanilla smelt time + buffer)
    await new Promise((resolve) => setTimeout(resolve, 11000));

    const output = furnace.outputItem();
    if (output) {
      await furnace.takeOutput();
      memory.collectItem(output.name, output.count || 1);
    }
    furnace.close();

    return { success: true, message: `Smelted some ${rawItemName}! 🔥`, output: output?.name };
  } catch (err) {
    logger.warn('action.smelt_failed', { item: rawItemName, error: err.message });
    return { success: false, message: `Tried to smelt ${rawItemName} but something went wrong: ${err.message}` };
  }
}

export default { craftItem, mineOre, gatherWood, comeToPlayer, smeltItem };
