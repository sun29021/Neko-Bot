/**
 * NEKO Goal System
 * 
 * Base Goal class that all bot objectives extend from.
 * Goals drive the bot's behavior with priorities, status tracking,
 * preconditions, and subtasks.
 * 
 * Usage:
 *   class MineGoal extends Goal {
 *     async execute(bot) {
 *       // Find ore, navigate, mine, collect
 *     }
 *   }
 *   
 *   const goal = new MineGoal('diamond', 10)
 *   await goal.execute(bot)
 */

import logger from './Logger.js';
import eventBus from './EventBus.js';

/**
 * Base Goal class
 * All goals extend this to define bot objectives
 */
export class Goal {
  constructor(name, priority = 5) {
    // Identity
    this.id = Math.random().toString(36).substr(2, 9);
    this.name = name; // 'mine_diamonds', 'eat', 'flee', etc.
    this.priority = priority; // 1-10, higher = more important

    // Status tracking
    this.status = 'idle'; // idle, active, paused, completed, failed
    this.progress = 0; // 0-100%
    this.startTime = null;
    this.endTime = null;
    this.duration = null; // milliseconds

    // Composition
    this.subtasks = []; // Child goals
    this.preconditions = []; // Must be true to start
    this.timeouts = {
      warning: 30000, // Warn if taking this long
      fail: 120000 // Fail if taking longer
    };

    // Tracking
    this.retries = 0;
    this.maxRetries = 3;
    this.errors = [];
    this.lastError = null;
  }

  /**
   * Check if goal can be executed (preconditions met)
   */
  async canExecute(context = {}) {
    // Check all preconditions
    for (const condition of this.preconditions) {
      if (typeof condition === 'function') {
        const result = await condition(context);
        if (!result) return false;
      }
    }
    return true;
  }

  /**
   * Main execute method - override in subclasses
   * @param {object} context - Bot context (playerState, systems, etc.)
   * @throws {GoalError} If goal cannot be completed
   */
  async execute(context) {
    throw new Error(`Goal.execute() not implemented for ${this.name}`);
  }

  /**
   * Start the goal - call before execute
   */
  async start(context = {}) {
    logger.info('goal.started', {
      goal: this.name,
      priority: this.priority,
      id: this.id
    });

    this.status = 'active';
    this.startTime = Date.now();
    this.progress = 0;

    eventBus.emit('goal.started', {
      goal: this.name,
      priority: this.priority
    });

    // Start timeout warning
    this.timeoutHandle = setTimeout(() => {
      if (this.status === 'active') {
        logger.warn('goal.taking_long', {
          goal: this.name,
          duration: Date.now() - this.startTime
        });
      }
    }, this.timeouts.warning);
  }

  /**
   * Complete the goal successfully
   */
  async complete(result = null) {
    clearTimeout(this.timeoutHandle);
    this.status = 'completed';
    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;

    logger.info('goal.completed', {
      goal: this.name,
      duration: this.duration,
      progress: this.progress,
      result
    });

    eventBus.emit('goal.completed', {
      goal: this.name,
      duration: this.duration,
      result
    });
  }

  /**
   * Pause the goal (can be resumed)
   */
  async pause(reason = 'paused') {
    if (this.status !== 'active') return;

    this.status = 'paused';

    logger.info('goal.paused', {
      goal: this.name,
      reason,
      progress: this.progress
    });

    eventBus.emit('goal.paused', {
      goal: this.name,
      reason
    });
  }

  /**
   * Resume a paused goal
   */
  async resume() {
    if (this.status !== 'paused') return;

    this.status = 'active';

    logger.info('goal.resumed', {
      goal: this.name,
      progress: this.progress
    });

    eventBus.emit('goal.resumed', {
      goal: this.name
    });
  }

  /**
   * Fail the goal with error
   */
  async fail(error = null, shouldRetry = true) {
    clearTimeout(this.timeoutHandle);

    if (error) {
      this.lastError = error;
      this.errors.push({
        time: Date.now(),
        error: error.message || String(error)
      });
    }

    // Try to retry if not exceeded max retries
    if (shouldRetry && this.retries < this.maxRetries) {
      this.retries += 1;
      logger.warn('goal.retrying', {
        goal: this.name,
        attempt: this.retries,
        maxRetries: this.maxRetries,
        error: error?.message
      });

      this.status = 'idle';
      eventBus.emit('goal.retrying', {
        goal: this.name,
        attempt: this.retries
      });

      return { retry: true };
    }

    // Give up
    this.status = 'failed';
    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;

    logger.error('goal.failed', {
      goal: this.name,
      duration: this.duration,
      error: error?.message || 'unknown',
      attempts: this.retries + 1
    });

    eventBus.emit('goal.failed', {
      goal: this.name,
      error: error?.message,
      attempts: this.retries + 1
    });

    return { retry: false };
  }

  /**
   * Cancel the goal
   */
  async cancel(reason = 'cancelled') {
    clearTimeout(this.timeoutHandle);
    this.status = 'cancelled';

    logger.info('goal.cancelled', {
      goal: this.name,
      reason,
      progress: this.progress
    });

    eventBus.emit('goal.cancelled', {
      goal: this.name,
      reason
    });
  }

  /**
   * Update progress (0-100)
   */
  setProgress(percent) {
    this.progress = Math.max(0, Math.min(100, percent));
    
    eventBus.emit('goal.progress', {
      goal: this.name,
      progress: this.progress
    });
  }

  /**
   * Add precondition that must be true to execute
   */
  require(condition) {
    this.preconditions.push(condition);
    return this;
  }

  /**
   * Add subtask
   */
  addSubtask(goal) {
    this.subtasks.push(goal);
    return this;
  }

  /**
   * Get goal information
   */
  getInfo() {
    return {
      id: this.id,
      name: this.name,
      priority: this.priority,
      status: this.status,
      progress: this.progress,
      duration: this.duration,
      retries: this.retries,
      lastError: this.lastError?.message
    };
  }

  /**
   * Get readable status
   */
  getStatusString() {
    const icons = {
      idle: '⭕',
      active: '▶️',
      paused: '⏸️',
      completed: '✅',
      failed: '❌',
      cancelled: '⛔'
    };

    return `${icons[this.status]} ${this.name} (${this.progress}%)`;
  }
}

/**
 * Composite goal that executes multiple goals in sequence
 */
export class SequenceGoal extends Goal {
  constructor(name, goals = [], priority = 5) {
    super(name, priority);
    this.goals = goals;
    this.currentGoalIndex = 0;
  }

  async execute(context) {
    for (let i = 0; i < this.goals.length; i++) {
      this.currentGoalIndex = i;
      const goal = this.goals[i];

      // Check preconditions
      if (!(await goal.canExecute(context))) {
        logger.warn('goal.precondition_failed', {
          parentGoal: this.name,
          subtask: goal.name
        });
        continue;
      }

      try {
        await goal.start(context);
        await goal.execute(context);
        await goal.complete();

        // Update parent progress
        this.setProgress((i / this.goals.length) * 100);
      } catch (error) {
        const result = await goal.fail(error, true);
        if (!result.retry) {
          throw error;
        }
        // Retry this goal
        i--;
      }
    }

    await this.complete();
  }
}

/**
 * Parallel goal that executes multiple goals at once
 */
export class ParallelGoal extends Goal {
  constructor(name, goals = [], priority = 5) {
    super(name, priority);
    this.goals = goals;
  }

  async execute(context) {
    const promises = this.goals.map(async (goal) => {
      if (!(await goal.canExecute(context))) {
        return null;
      }

      try {
        await goal.start(context);
        await goal.execute(context);
        await goal.complete();
        return goal;
      } catch (error) {
        await goal.fail(error, false);
        throw error;
      }
    });

    await Promise.all(promises);
    await this.complete();
  }
}

/**
 * Goal error class
 */
export class GoalError extends Error {
  constructor(message, goal) {
    super(message);
    this.name = 'GoalError';
    this.goal = goal;
  }
}

export default Goal;
