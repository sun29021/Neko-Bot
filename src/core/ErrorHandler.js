/**
 * NEKO Error Handler
 * 
 * Centralized error management with custom error types, recovery strategies,
 * and error telemetry for debugging and monitoring.
 * 
 * Usage:
 *   try {
 *     await pathfinder.findPath(start, goal)
 *   } catch (error) {
 *     if (error instanceof PathBlockedError) {
 *       // Handle blocked path
 *     }
 *     errorHandler.report(error, { context: 'pathfinding' })
 *   }
 */

import logger from './Logger.js';

// ============================================================
// CUSTOM ERROR CLASSES
// ============================================================

/**
 * Base BotError class
 * All bot-specific errors extend this
 */
export class BotError extends Error {
  constructor(message, code, severity = 'error', recoverable = true) {
    super(message);
    this.name = this.constructor.name;
    this.code = code; // Machine-readable error code
    this.severity = severity; // 'warn', 'error', 'fatal'
    this.recoverable = recoverable; // Can the bot recover?
    this.timestamp = Date.now();
    this.context = {}; // Additional context data
    
    // Capture stack trace
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Add context data to error
   */
  withContext(context) {
    this.context = { ...this.context, ...context };
    return this;
  }
}

/**
 * Movement/Navigation Errors
 */
export class PathBlockedError extends BotError {
  constructor(message = 'Path blocked or unreachable') {
    super(message, 'PATH_BLOCKED', 'warn', true);
  }
}

export class NavigationError extends BotError {
  constructor(message = 'Navigation failed') {
    super(message, 'NAVIGATION_ERROR', 'error', true);
  }
}

export class DestinationUnreachableError extends BotError {
  constructor(message = 'Destination is unreachable') {
    super(message, 'UNREACHABLE', 'warn', true);
  }
}

/**
 * Inventory/Resource Errors
 */
export class InventoryFullError extends BotError {
  constructor(message = 'Inventory is full') {
    super(message, 'INVENTORY_FULL', 'warn', true);
  }
}

export class ItemNotFoundError extends BotError {
  constructor(message = 'Item not found in inventory') {
    super(message, 'ITEM_NOT_FOUND', 'warn', true);
  }
}

/**
 * Combat/Health Errors
 */
export class HealthCriticalError extends BotError {
  constructor(message = 'Health critical') {
    super(message, 'HEALTH_CRITICAL', 'error', true);
  }
}

export class MobThreatError extends BotError {
  constructor(message = 'Mob threat detected') {
    super(message, 'MOB_THREAT', 'warn', true);
  }
}

/**
 * Gameplay Errors
 */
export class BlockNotAccessibleError extends BotError {
  constructor(message = 'Block not accessible') {
    super(message, 'BLOCK_NOT_ACCESSIBLE', 'warn', true);
  }
}

export class ActionFailedError extends BotError {
  constructor(message = 'Action failed') {
    super(message, 'ACTION_FAILED', 'error', true);
  }
}

/**
 * Network/API Errors
 */
export class APIError extends BotError {
  constructor(message = 'API request failed') {
    super(message, 'API_ERROR', 'error', true);
  }
}

export class ConnectionError extends BotError {
  constructor(message = 'Connection failed') {
    super(message, 'CONNECTION_ERROR', 'error', true);
  }
}

export class TimeoutError extends BotError {
  constructor(message = 'Operation timed out') {
    super(message, 'TIMEOUT', 'warn', true);
  }
}

/**
 * State/Configuration Errors
 */
export class StateError extends BotError {
  constructor(message = 'Bot in unexpected state') {
    super(message, 'STATE_ERROR', 'error', false);
  }
}

export class ConfigError extends BotError {
  constructor(message = 'Configuration error') {
    super(message, 'CONFIG_ERROR', 'fatal', false);
  }
}

// ============================================================
// ERROR HANDLER MANAGER
// ============================================================

/**
 * Centralized error handler for the bot
 * Tracks errors, provides recovery strategies, and telemetry
 */
class ErrorHandler {
  constructor(config = {}) {
    this.config = {
      maxErrors: config.maxErrors || 100,
      enableTelemetry: config.enableTelemetry !== false,
      enableAutoRecovery: config.enableAutoRecovery !== false,
      ...config
    };

    this.errorHistory = [];
    this.recoveryStrategies = new Map();
    this.setupDefaultStrategies();
  }

  /**
   * Setup default recovery strategies for common errors
   */
  setupDefaultStrategies() {
    // Path blocked - try alternative route
    this.registerStrategy('PATH_BLOCKED', async (error, context) => {
      logger.warn('error.recovery', { 
        code: 'PATH_BLOCKED',
        action: 'Trying alternative route'
      });
      // Return instruction to try different goal
      return { retry: true, alternative: true };
    });

    // Inventory full - drop less important items
    this.registerStrategy('INVENTORY_FULL', async (error, context) => {
      logger.warn('error.recovery', {
        code: 'INVENTORY_FULL',
        action: 'Dropping items'
      });
      return { dropItems: true, priority: 'low_value' };
    });

    // Mob threat - flee to safety
    this.registerStrategy('MOB_THREAT', async (error, context) => {
      logger.warn('error.recovery', {
        code: 'MOB_THREAT',
        action: 'Fleeing from mobs'
      });
      return { flee: true, direction: 'away' };
    });

    // Health critical - eat and hide
    this.registerStrategy('HEALTH_CRITICAL', async (error, context) => {
      logger.error('error.recovery', {
        code: 'HEALTH_CRITICAL',
        action: 'Eating and hiding'
      });
      return { eat: true, hideFromMobs: true };
    });

    // API error - use fallback
    this.registerStrategy('API_ERROR', async (error, context) => {
      logger.warn('error.recovery', {
        code: 'API_ERROR',
        action: 'Using fallback response'
      });
      return { useFallback: true };
    });

    // Connection error - attempt reconnection
    this.registerStrategy('CONNECTION_ERROR', async (error, context) => {
      logger.error('error.recovery', {
        code: 'CONNECTION_ERROR',
        action: 'Attempting reconnection'
      });
      return { reconnect: true, delay: 5000 };
    });

    // Timeout - retry with longer timeout
    this.registerStrategy('TIMEOUT', async (error, context) => {
      logger.warn('error.recovery', {
        code: 'TIMEOUT',
        action: 'Retrying with longer timeout'
      });
      return { retry: true, timeout: (context.timeout || 5000) * 2 };
    });
  }

  /**
   * Register a recovery strategy for an error code
   */
  registerStrategy(code, handler) {
    this.recoveryStrategies.set(code, handler);
  }

  /**
   * Report an error
   * Logs it, stores it, and attempts recovery if possible
   */
  async report(error, context = {}) {
    // Normalize error
    const normalizedError = this.normalizeError(error);

    // Add context
    normalizedError.context = { ...normalizedError.context, ...context };

    // Log the error
    logger.log(
      normalizedError.severity.toUpperCase(),
      `error.${normalizedError.code}`,
      {
        message: normalizedError.message,
        code: normalizedError.code,
        context: normalizedError.context,
        stack: normalizedError.stack?.split('\n').slice(0, 3) // First 3 lines
      }
    );

    // Store in history
    this.storeError(normalizedError);

    // Attempt recovery if enabled
    if (this.config.enableAutoRecovery && normalizedError.recoverable) {
      return await this.attemptRecovery(normalizedError);
    }

    return { recovered: false };
  }

  /**
   * Normalize different error types to BotError
   */
  normalizeError(error) {
    if (error instanceof BotError) {
      return error;
    }

    // Convert standard Error to BotError
    const botError = new BotError(
      error.message || 'Unknown error',
      error.code || 'UNKNOWN_ERROR',
      'error',
      true
    );
    botError.stack = error.stack;
    return botError;
  }

  /**
   * Store error in history with deduplication
   */
  storeError(error) {
    this.errorHistory.push({
      timestamp: Date.now(),
      code: error.code,
      message: error.message,
      severity: error.severity,
      count: 1
    });

    // Keep only recent errors
    if (this.errorHistory.length > this.config.maxErrors) {
      this.errorHistory.shift();
    }
  }

  /**
   * Attempt to recover from error using registered strategies
   */
  async attemptRecovery(error) {
    const strategy = this.recoveryStrategies.get(error.code);

    if (!strategy) {
      logger.debug('error.no_strategy', {
        code: error.code,
        message: 'No recovery strategy found'
      });
      return { recovered: false, reason: 'no_strategy' };
    }

    try {
      logger.info('error.recovery_attempt', {
        code: error.code,
        strategy: error.code
      });

      const result = await strategy(error, error.context);
      
      logger.info('error.recovery_success', {
        code: error.code,
        result
      });

      return { recovered: true, result };
    } catch (recoveryError) {
      logger.error('error.recovery_failed', {
        originalError: error.code,
        recoveryError: recoveryError.message
      });

      return { recovered: false, reason: 'recovery_failed' };
    }
  }

  /**
   * Get error history
   */
  getHistory(limit = 50) {
    return this.errorHistory.slice(-limit);
  }

  /**
   * Get error statistics
   */
  getStats() {
    const stats = {
      total: this.errorHistory.length,
      byCode: {},
      bySeverity: {
        warn: 0,
        error: 0,
        fatal: 0
      }
    };

    for (const error of this.errorHistory) {
      // Count by code
      stats.byCode[error.code] = (stats.byCode[error.code] || 0) + 1;
      
      // Count by severity
      stats.bySeverity[error.severity] = (stats.bySeverity[error.severity] || 0) + 1;
    }

    return stats;
  }

  /**
   * Clear error history
   */
  clear() {
    this.errorHistory = [];
  }
}

// Create and export singleton
const errorHandler = new ErrorHandler({
  maxErrors: 100,
  enableTelemetry: true,
  enableAutoRecovery: true
});

export default errorHandler;
