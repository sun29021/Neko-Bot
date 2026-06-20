/**
 * NEKO Event Bus
 * 
 * Internal pub/sub event system for loose coupling between bot systems.
 * All major events go through the bus instead of direct Mineflayer events.
 * 
 * Usage:
 *   // Emit event
 *   eventBus.emit('player.damaged', { damage: 5, source: 'zombie' })
 *   
 *   // Listen to event
 *   eventBus.on('player.damaged', (data) => {
 *     console.log('Took', data.damage, 'damage from', data.source)
 *   })
 *   
 *   // Unsubscribe
 *   eventBus.off('player.damaged', callback)
 *   
 *   // One-time listener
 *   eventBus.once('player.death', () => {
 *     console.log('Died!')
 *   })
 */

import logger from './Logger.js';

/**
 * Event Bus for internal bot communication
 * Decouples systems so they don't depend directly on each other
 */
class EventBus {
  constructor() {
    this.subscribers = new Map(); // Map of event -> [callbacks]
    this.eventHistory = []; // Track emitted events
    this.maxHistorySize = 500;
    this.enabled = true;
  }

  /**
   * Subscribe to an event
   * Returns unsubscribe function
   */
  on(event, callback, priority = 0) {
    if (!this.subscribers.has(event)) {
      this.subscribers.set(event, []);
    }

    // Add listener with priority (higher priority = called first)
    const listener = { callback, priority, id: Math.random() };
    const listeners = this.subscribers.get(event);
    listeners.push(listener);
    listeners.sort((a, b) => b.priority - a.priority);

    // Return unsubscribe function
    return () => this.off(event, callback);
  }

  /**
   * Subscribe to event only once
   */
  once(event, callback, priority = 0) {
    const unsubscribe = this.on(event, (data) => {
      unsubscribe();
      callback(data);
    }, priority);
    return unsubscribe;
  }

  /**
   * Unsubscribe from event
   */
  off(event, callback) {
    if (!this.subscribers.has(event)) return;

    const listeners = this.subscribers.get(event);
    const index = listeners.findIndex(l => l.callback === callback);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
  }

  /**
   * Emit an event synchronously
   */
  emit(event, data = {}) {
    if (!this.enabled) return;

    // Record in history
    this.recordEvent(event, data);

    // Get listeners for this event (and wildcard listeners)
    const listeners = this.subscribers.get(event) || [];
    const wildcardListeners = this.subscribers.get('*') || [];
    const allListeners = [...listeners, ...wildcardListeners];

    if (allListeners.length === 0) {
      return; // No listeners for this event
    }

    // Call all listeners
    for (const listener of allListeners) {
      try {
        listener.callback(data, event);
      } catch (error) {
        logger.error('eventbus.listener_error', {
          event,
          error: error.message,
          stack: error.stack?.split('\n')[0]
        });
      }
    }
  }

  /**
   * Emit event asynchronously
   * Waits for all listeners to complete before resolving
   */
  async emitAsync(event, data = {}) {
    if (!this.enabled) return;

    this.recordEvent(event, data);

    const listeners = this.subscribers.get(event) || [];
    const wildcardListeners = this.subscribers.get('*') || [];
    const allListeners = [...listeners, ...wildcardListeners];

    // Execute all listeners in parallel
    const promises = allListeners.map(async (listener) => {
      try {
        const result = listener.callback(data, event);
        // Handle both sync and async callbacks
        if (result instanceof Promise) {
          return await result;
        }
        return result;
      } catch (error) {
        logger.error('eventbus.async_listener_error', {
          event,
          error: error.message
        });
        throw error;
      }
    });

    // Wait for all to complete
    return Promise.all(promises);
  }

  /**
   * Record event in history for debugging
   */
  recordEvent(event, data) {
    this.eventHistory.push({
      event,
      data,
      timestamp: Date.now()
    });

    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }
  }

  /**
   * Get recent events
   */
  getHistory(count = 50, filter = null) {
    let history = this.eventHistory.slice(-count);
    
    if (filter) {
      history = history.filter(e => {
        if (typeof filter === 'string') {
          return e.event === filter;
        } else if (filter instanceof RegExp) {
          return filter.test(e.event);
        }
        return true;
      });
    }

    return history;
  }

  /**
   * Get listener count for event
   */
  getListenerCount(event) {
    return (this.subscribers.get(event) || []).length;
  }

  /**
   * Get all subscribed events
   */
  getSubscribedEvents() {
    return Array.from(this.subscribers.keys());
  }

  /**
   * Clear all listeners
   */
  clear(event = null) {
    if (event) {
      this.subscribers.delete(event);
    } else {
      this.subscribers.clear();
    }
  }

  /**
   * Disable/enable event bus temporarily
   */
  disable() {
    this.enabled = false;
  }

  resume() {
    this.enabled = true;
  }

  /**
   * Get event statistics
   */
  getStats() {
    const stats = {
      subscribedEvents: this.subscribers.size,
      totalListeners: 0,
      byEvent: {}
    };

    for (const [event, listeners] of this.subscribers) {
      stats.byEvent[event] = listeners.length;
      stats.totalListeners += listeners.length;
    }

    return stats;
  }
}

// Export singleton
const eventBus = new EventBus();

// Define standard events that the bot emits
// These can be imported by modules for type safety

export const BOT_EVENTS = {
  // Connection events
  'bot.connecting': 'Bot attempting to connect',
  'bot.connected': 'Bot successfully connected',
  'bot.disconnected': 'Bot disconnected from server',
  'bot.error': 'Critical bot error',
  'bot.spawned': 'Bot spawned in world',

  // Player events
  'player.chat': 'Player sent chat message',
  'player.damaged': 'Bot took damage',
  'player.healed': 'Bot recovered health',
  'player.death': 'Bot died',
  'player.respawned': 'Bot respawned',

  // Inventory events
  'inventory.updated': 'Inventory contents changed',
  'inventory.full': 'Inventory is full',
  'inventory.item_dropped': 'Item dropped',

  // Movement events
  'movement.started': 'Bot started moving',
  'movement.stopped': 'Bot stopped moving',
  'movement.stuck': 'Bot is stuck in one location',

  // Combat events
  'combat.attack': 'Bot attacked a mob',
  'combat.mob_detected': 'Hostile mob detected',
  'combat.fled': 'Bot fled from danger',

  // Gathering events
  'gathering.mining_started': 'Mining operation started',
  'gathering.block_mined': 'Block successfully mined',
  'gathering.farming_started': 'Farming operation started',

  // AI events
  'ai.goal_started': 'New goal started',
  'ai.goal_completed': 'Goal completed',
  'ai.learning_recorded': 'Experience recorded for learning',
  'ai.strategy_updated': 'Bot strategy changed',

  // Chat events
  'chat.response_generated': 'Chat response generated',
  'chat.command_executed': 'Chat command executed',

  // System events
  'system.error': 'System error occurred',
  'system.warning': 'System warning',
  'system.tick': 'Game tick (internal use)'
};

export default eventBus;
