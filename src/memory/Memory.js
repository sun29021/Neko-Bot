/**
 * NEKO Memory System
 *
 * WHAT THIS FILE DOES:
 * Gives NEKO long-term memory that survives restarts. Without this, every
 * time the bot reconnects (e.g. after a Railway redeploy) it would forget
 * every player it has met, every nickname it learned, and all base/progress
 * info — that's what makes the "remembers locations and events" personality
 * trait (goal #24 in your spec) actually possible.
 *
 * HOW IT WORKS:
 * - All memory lives in one JS object: `this.data`
 * - `load()` reads it from disk on startup (data/memory.json by default)
 * - `save()` writes it back to disk; this happens automatically on a timer
 *   (autoSaveInterval from settings.json) AND on every important change,
 *   AND on graceful shutdown (wired in index.js)
 * - If the file doesn't exist yet (first run) or is corrupted, we fall back
 *   to a fresh default structure instead of crashing.
 *
 * The API on this module intentionally matches what your reference
 * nekoChatHandler.js already calls (memory.getMemoryContext(),
 * memory.saveNickname(), memory.data.players, etc.) so Phase 3 can wire
 * the chat handler in without rewriting it from scratch.
 *
 * Usage:
 *   import memory from '../memory/Memory.js'
 *   memory.recordPlayerInteraction('Steve', 'hi', 'sup nerd')
 *   const ctx = memory.getMemoryContext()
 */

import fs from 'fs';
import path from 'path';
import logger from '../core/Logger.js';
import eventBus from '../core/EventBus.js';
import config from '../config.js';

/**
 * Builds a brand-new, empty memory structure.
 * Used on first run, or if the save file is missing/corrupted.
 */
function createDefaultData() {
  return {
    // ----- Self-knowledge / survival stats -----
    daysAlive: 0,
    totalDeaths: 0,
    confidenceLevel: 0, // 0-100, grows with successful experiences
    lastSurvivalCheck: Date.now(),
    createdAt: Date.now(),

    // ----- Players NEKO has interacted with -----
    // playerName -> { firstSeen, lastSeen, nickname, interactions: [], likes: [], dislikes: [] }
    players: {},

    // ----- Base / building progress -----
    base: {
      location: null, // { x, y, z } once a base site is chosen
      upgrades: ['none'], // history of base tiers reached
      nextUpgrade: 'dirt_shelter',
      resourcesCollected: 0
    },

    // ----- Inventory tracking (mirrors PlayerState but persists) -----
    inventory: {
      wood: 0,
      stone: 0,
      iron: 0,
      gold: 0,
      diamond: 0,
      other: {} // itemName -> count for anything not explicitly tracked
    },

    // ----- Known locations of interest (structures, biomes, resources) -----
    // name -> { x, y, z, type, discoveredAt }
    locations: {},

    // ----- Special players from settings.json (creator, roast target, etc.) -----
    specialPlayers: config.memory.specialPlayers || {}
  };
}

class Memory {
  constructor() {
    this.savePath = config.memory.savePath;
    this.data = createDefaultData();
    this.autoSaveHandle = null;
    this.dirty = false; // tracks whether there are unsaved changes
  }

  /**
   * Load memory from disk. Call this once, after the bot spawns.
   * Safe to call even if the file doesn't exist yet.
   */
  load() {
    try {
      if (fs.existsSync(this.savePath)) {
        const raw = fs.readFileSync(this.savePath, 'utf8');
        const parsed = JSON.parse(raw);

        // Merge with defaults so new fields added in future versions
        // don't crash on an old save file that's missing them.
        this.data = { ...createDefaultData(), ...parsed };
        this.data.base = { ...createDefaultData().base, ...(parsed.base || {}) };
        this.data.inventory = { ...createDefaultData().inventory, ...(parsed.inventory || {}) };

        logger.info('memory.loaded', {
          players: Object.keys(this.data.players).length,
          daysAlive: this.data.daysAlive
        });
      } else {
        logger.info('memory.no_save_found', { path: this.savePath });
      }
    } catch (err) {
      // Corrupted file - don't crash, just start fresh and warn loudly.
      logger.error('memory.load_failed', { error: err.message });
      this.data = createDefaultData();
    }

    // Start autosave loop if configured
    if (config.memory.autoSave) {
      this.startAutoSave();
    }

    return this.data;
  }

  /**
   * Write current memory to disk immediately.
   */
  save() {
    try {
      const dir = path.dirname(this.savePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.savePath, JSON.stringify(this.data, null, 2), 'utf8');
      this.dirty = false;
      logger.debug('memory.saved', { path: this.savePath });
    } catch (err) {
      logger.error('memory.save_failed', { error: err.message });
    }
  }

  // Alias kept for compatibility with the reference chat handler,
  // which calls memory.saveMemory() in a couple of places.
  saveMemory() {
    this.save();
  }

  /**
   * Starts the periodic autosave timer. Avoids writing to disk on every
   * single change (which would be wasteful) - instead, changes mark the
   * data 'dirty' and this timer flushes it periodically.
   */
  startAutoSave() {
    if (this.autoSaveHandle) clearInterval(this.autoSaveHandle);

    this.autoSaveHandle = setInterval(() => {
      if (this.dirty) {
        this.save();
      }
    }, config.memory.autoSaveInterval);

    // Don't let this timer keep the process alive on its own - if every
    // other handle (bot connection, server) closes, the process should
    // still be able to exit cleanly instead of hanging on this timer.
    this.autoSaveHandle.unref();
  }

  stopAutoSave() {
    if (this.autoSaveHandle) {
      clearInterval(this.autoSaveHandle);
      this.autoSaveHandle = null;
    }
  }

  // ============================================================
  // PLAYER TRACKING
  // ============================================================

  /**
   * Ensures a player record exists, creating one on first contact.
   */
  ensurePlayer(playerName) {
    if (!this.data.players[playerName]) {
      this.data.players[playerName] = {
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        nickname: null,
        interactions: [],
        likes: [],
        dislikes: []
      };
      this.dirty = true;
      eventBus.emit('memory.new_player', { playerName });
    }
    return this.data.players[playerName];
  }

  /**
   * Records a single chat interaction with a player.
   * Trims history to maxInteractionHistory so the file doesn't grow forever.
   */
  recordPlayerInteraction(playerName, message, response) {
    const player = this.ensurePlayer(playerName);
    player.lastSeen = Date.now();
    player.interactions.push({ message, response, timestamp: Date.now() });

    const max = config.memory.maxInteractionHistory;
    if (player.interactions.length > max) {
      player.interactions = player.interactions.slice(-max);
    }

    this.dirty = true;
  }

  /**
   * Saves a nickname a player asked to be called.
   */
  saveNickname(playerName, nickname) {
    const player = this.ensurePlayer(playerName);
    player.nickname = nickname;
    this.dirty = true;
    logger.info('memory.nickname_saved', { playerName, nickname });
  }

  /**
   * Gets the name NEKO should use when addressing this player -
   * their chosen nickname if set, otherwise their Minecraft username.
   * Also checks specialPlayers from settings.json (e.g. creator nickname).
   */
  getDisplayName(playerName) {
    if (this.data.specialPlayers[playerName]?.nickname) {
      return this.data.specialPlayers[playerName].nickname;
    }
    return this.data.players[playerName]?.nickname || playerName;
  }

  /**
   * Caps total tracked players at maxPlayerHistory by dropping the
   * least-recently-seen player. Call occasionally (e.g. on autosave).
   */
  pruneOldPlayers() {
    const names = Object.keys(this.data.players);
    const max = config.memory.maxPlayerHistory;
    if (names.length <= max) return;

    const sorted = names.sort(
      (a, b) => this.data.players[a].lastSeen - this.data.players[b].lastSeen
    );
    const toRemove = sorted.slice(0, names.length - max);
    for (const name of toRemove) {
      delete this.data.players[name];
    }
    this.dirty = true;
  }

  // ============================================================
  // CONFIDENCE / SURVIVAL
  // ============================================================

  /**
   * Raises confidence (called after wins: mob kills, successful mining, etc.)
   */
  increaseConfidence(amount = 5) {
    this.data.confidenceLevel = Math.min(100, this.data.confidenceLevel + amount);
    this.dirty = true;
  }

  /**
   * Lowers confidence (called after near-deaths, failures).
   */
  decreaseConfidence(amount = 10) {
    this.data.confidenceLevel = Math.max(0, this.data.confidenceLevel - amount);
    this.dirty = true;
  }

  /**
   * Records a near-death experience - hurts confidence and is tracked
   * for the learning system (Phase 5) to analyze later.
   */
  recordNearDeath() {
    this.decreaseConfidence(15);
    this.dirty = true;
    eventBus.emit('memory.near_death', { confidence: this.data.confidenceLevel });
  }

  /**
   * Returns a human-readable confidence label, used by the !confidence
   * chat command.
   */
  getConfidenceLevel() {
    const level = this.data.confidenceLevel;
    if (level >= 80) return 'Fearless 😎';
    if (level >= 60) return 'Confident 💪';
    if (level >= 40) return 'Cautious 🤔';
    if (level >= 20) return 'Nervous 😬';
    return 'Shaky 😰';
  }

  // ============================================================
  // INVENTORY / RESOURCES
  // ============================================================

  /**
   * Records a collected item. Known resource types get their own counter,
   * everything else goes into inventory.other.
   */
  collectItem(itemName, quantity = 1) {
    const key = itemName.toLowerCase();

    // Map common Minecraft item name variants to our tracked categories.
    // e.g. "oak_log", "spruce_planks" should all count as "wood".
    const categoryMatchers = {
      wood: ['log', 'planks', 'wood'],
      stone: ['cobblestone', 'stone'],
      iron: ['iron'],
      gold: ['gold'],
      diamond: ['diamond']
    };

    const matchedCategory = Object.keys(categoryMatchers).find((category) =>
      categoryMatchers[category].some((substr) => key.includes(substr))
    );

    if (matchedCategory) {
      this.data.inventory[matchedCategory] += quantity;
    } else {
      this.data.inventory.other[key] = (this.data.inventory.other[key] || 0) + quantity;
    }

    this.data.base.resourcesCollected += quantity;
    this.dirty = true;
  }

  // ============================================================
  // LOCATIONS
  // ============================================================

  /**
   * Remembers a location of interest (village, ravine, ore vein, etc.)
   */
  rememberLocation(name, position, type = 'unknown') {
    this.data.locations[name] = {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
      type,
      discoveredAt: Date.now()
    };
    this.dirty = true;
    eventBus.emit('memory.location_discovered', { name, type, position });
  }

  // ============================================================
  // CONTEXT FOR AI / CHAT
  // ============================================================

  /**
   * Returns a compact summary of memory state, meant to be fed into the
   * chat AI's prompt as context (so NEKO can reference what she remembers
   * without dumping the entire memory file into every API call).
   */
  getMemoryContext() {
    return {
      daysAlive: this.data.daysAlive,
      confidenceLevel: this.data.confidenceLevel,
      confidenceLabel: this.getConfidenceLevel(),
      knownPlayerCount: Object.keys(this.data.players).length,
      base: { ...this.data.base },
      totalResourcesCollected: this.data.base.resourcesCollected,
      knownLocationCount: Object.keys(this.data.locations).length
    };
  }
}

// Export a singleton, same pattern as Logger/EventBus/ErrorHandler.
const memory = new Memory();
export default memory;
