/**
 * NEKO Player State
 * 
 * Represents the bot as a Minecraft player entity.
 * Centralizes all state information about the bot: position, health, hunger,
 * inventory, equipment, movement state, etc.
 * 
 * Usage:
 *   const state = playerState.getSnapshot() // Get current state
 *   playerState.setHealth(15) // Update health
 *   playerState.addInventoryItem('diamond', 3) // Track items
 */

import logger from './Logger.js';
import eventBus from './EventBus.js';

/**
 * PlayerState manages the bot's entity state
 * Acts as single source of truth for bot status
 */
class PlayerState {
  constructor(bot) {
    this.bot = bot; // Reference to Mineflayer bot

    // Position & Movement
    this.position = { x: 0, y: 0, z: 0 };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.isMoving = false;
    this.lastMoveTime = Date.now();

    // Health & Status
    this.health = 20;
    this.maxHealth = 20;
    this.hunger = 20;
    this.maxHunger = 20;
    this.saturation = 5;
    this.experience = 0;

    // Equipment & Tools
    this.equipment = {
      head: null,
      chest: null,
      legs: null,
      feet: null,
      mainHand: null,
      offHand: null
    };

    // Inventory & Resources
    this.inventory = {
      items: {}, // itemName -> count
      maxSlots: 36,
      usedSlots: 0
    };

    // Current State
    this.currentTask = null;
    this.currentGoal = null;
    this.currentAction = null;
    this.isInCombat = false;
    this.isInDanger = false;
    this.nearbyMobs = [];
    this.dimension = 'overworld';

    // Tracking
    this.statisticslogged = {
      distanceTraveled: 0,
      blocksDestroyed: 0,
      blocksPlaced: 0,
      mobsKilled: 0,
      timesDefeated: 0,
      itemsCrafted: 0,
      blocksInteracted: 0
    };

    this.syncWithBot();
  }

  /**
   * Synchronize state from bot instance
   * Call this whenever bot state might have changed
   */
  syncWithBot() {
    if (!this.bot) return;

    // Sync position
    const oldPos = { ...this.position };
    this.position = {
      x: this.bot.entity?.position?.x || this.position.x,
      y: this.bot.entity?.position?.y || this.position.y,
      z: this.bot.entity?.position?.z || this.position.z
    };

    // Detect if moved
    if (oldPos.x !== this.position.x || oldPos.z !== this.position.z) {
      this.isMoving = true;
      this.lastMoveTime = Date.now();
      const distance = Math.hypot(
        this.position.x - oldPos.x,
        this.position.z - oldPos.z
      );
      this.statisticslogged.distanceTraveled += distance;
    } else if (Date.now() - this.lastMoveTime > 1000) {
      this.isMoving = false;
    }

    // Sync health
    if (this.bot.health !== undefined) {
      const oldHealth = this.health;
      this.health = Math.round(this.bot.health);
      
      if (this.health < oldHealth) {
        eventBus.emit('player.damaged', {
          damage: oldHealth - this.health,
          currentHealth: this.health
        });
      }
    }

    // Sync hunger
    if (this.bot.food !== undefined) {
      this.hunger = this.bot.food;
    }

    // Sync saturation
    if (this.bot.foodSaturation !== undefined) {
      this.saturation = this.bot.foodSaturation;
    }

    // Sync dimension
    if (this.bot.dimension) {
      this.dimension = this.bot.dimension;
    }

    // Sync inventory
    this.syncInventory();
  }

  /**
   * Synchronize inventory from bot
   */
  syncInventory() {
    if (!this.bot || !this.bot.inventory) return;

    this.inventory.items = {};
    this.inventory.usedSlots = 0;

    for (const item of this.bot.inventory.items()) {
      const name = item?.type?.name || 'unknown';
      this.inventory.items[name] = (this.inventory.items[name] || 0) + item.count;
      this.inventory.usedSlots += 1; // One slot per stack
    }

    eventBus.emit('inventory.updated', {
      items: this.inventory.items,
      usedSlots: this.inventory.usedSlots
    });
  }

  /**
   * Get current position
   */
  getPosition() {
    return { ...this.position };
  }

  /**
   * Get distance to a point
   */
  getDistance(x, y, z) {
    return Math.hypot(
      this.position.x - x,
      this.position.y - y,
      this.position.z - z
    );
  }

  /**
   * Update health
   */
  setHealth(value) {
    const oldHealth = this.health;
    this.health = Math.max(0, Math.min(20, value));
    
    if (this.health < oldHealth) {
      eventBus.emit('player.damaged', {
        damage: oldHealth - this.health,
        currentHealth: this.health
      });
    }

    if (this.health === 0) {
      eventBus.emit('player.death');
    }
  }

  /**
   * Update hunger
   */
  setHunger(value) {
    this.hunger = Math.max(0, Math.min(20, value));
  }

  /**
   * Add item to tracked inventory
   */
  addInventoryItem(itemName, count = 1) {
    const name = itemName.toLowerCase();
    this.inventory.items[name] = (this.inventory.items[name] || 0) + count;
    
    eventBus.emit('inventory.updated', {
      itemAdded: name,
      count,
      total: this.inventory.items[name]
    });
  }

  /**
   * Remove item from tracked inventory
   */
  removeInventoryItem(itemName, count = 1) {
    const name = itemName.toLowerCase();
    if (!this.inventory.items[name]) return false;
    
    this.inventory.items[name] = Math.max(0, this.inventory.items[name] - count);
    
    if (this.inventory.items[name] === 0) {
      delete this.inventory.items[name];
    }

    eventBus.emit('inventory.updated', {
      itemRemoved: name,
      count,
      remaining: this.inventory.items[name] || 0
    });

    return true;
  }

  /**
   * Get item count
   */
  getItemCount(itemName) {
    return this.inventory.items[itemName.toLowerCase()] || 0;
  }

  /**
   * Check if inventory is full
   */
  isInventoryFull() {
    return this.inventory.usedSlots >= this.inventory.maxSlots;
  }

  /**
   * Get available inventory space
   */
  getAvailableSlots() {
    return this.inventory.maxSlots - this.inventory.usedSlots;
  }

  /**
   * Update current task
   */
  setCurrentTask(taskName, taskData = {}) {
    this.currentTask = {
      name: taskName,
      data: taskData,
      startTime: Date.now()
    };

    eventBus.emit('player.task_updated', {
      task: taskName,
      data: taskData
    });
  }

  /**
   * Update current goal
   */
  setCurrentGoal(goalName, goalData = {}) {
    this.currentGoal = {
      name: goalName,
      data: goalData,
      startTime: Date.now()
    };

    eventBus.emit('ai.goal_started', {
      goal: goalName,
      data: goalData
    });
  }

  /**
   * Clear current task
   */
  clearTask() {
    this.currentTask = null;
  }

  /**
   * Update combat status
   */
  setInCombat(inCombat, enemyType = null) {
    const wasInCombat = this.isInCombat;
    this.isInCombat = inCombat;

    if (inCombat && !wasInCombat) {
      eventBus.emit('combat.started', { enemy: enemyType });
    } else if (!inCombat && wasInCombat) {
      eventBus.emit('combat.ended');
    }
  }

  /**
   * Update danger status
   */
  setInDanger(inDanger) {
    this.isInDanger = inDanger;
    if (inDanger) {
      eventBus.emit('player.in_danger');
    }
  }

  /**
   * Set nearby mobs.
   * BUG FIX: previously only emitted `{ mobs: mobs.length }` (a number),
   * but downstream consumers (chat event analysis, learning system) need
   * the actual mob list to check names/types. Now emits both.
   */
  setNearbyMobs(mobs) {
    this.nearbyMobs = mobs;
    eventBus.emit('combat.mobs_detected', { mobs, count: mobs.length });
  }

  /**
   * Record statistic
   */
  recordStat(key, value) {
    if (this.statisticslogged[key] !== undefined) {
      this.statisticslogged[key] += value;
    }
  }

  /**
   * Get complete state snapshot
   */
  getSnapshot() {
    return {
      position: { ...this.position },
      health: this.health,
      maxHealth: this.maxHealth,
      hunger: this.hunger,
      saturation: this.saturation,
      experience: this.experience,
      isMoving: this.isMoving,
      isInCombat: this.isInCombat,
      isInDanger: this.isInDanger,
      currentTask: this.currentTask,
      currentGoal: this.currentGoal,
      inventory: {
        items: { ...this.inventory.items },
        usedSlots: this.inventory.usedSlots,
        maxSlots: this.inventory.maxSlots
      },
      nearbyMobs: this.nearbyMobs.length,
      dimension: this.dimension,
      stats: { ...this.statisticslogged }
    };
  }

  /**
   * Get health percentage
   */
  getHealthPercent() {
    return (this.health / this.maxHealth) * 100;
  }

  /**
   * Is bot in critical health?
   */
  isCriticalHealth() {
    return this.health <= 5;
  }

  /**
   * Is bot starving?
   */
  isStarving() {
    return this.hunger <= 3;
  }

  /**
   * Get status summary for logging
   */
  getStatusSummary() {
    return `Health: ${this.health}/${this.maxHealth} | Hunger: ${this.hunger}/20 | Pos: (${Math.floor(this.position.x)}, ${Math.floor(this.position.y)}, ${Math.floor(this.position.z)}) | Task: ${this.currentTask?.name || 'idle'}`;
  }
}

export default PlayerState;
