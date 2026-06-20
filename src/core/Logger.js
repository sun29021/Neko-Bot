/**
 * NEKO Structured Logger
 * 
 * Provides multi-level logging with context, timestamps, and structured output.
 * Supports console and file output with automatic rotation.
 * 
 * Usage:
 *   logger.info('system.startup', { version: '3.0.0' })
 *   logger.warn('movement.stuck', { position: { x, y, z }, duration: 5000 })
 *   logger.error('combat.failed', { reason: 'mob_too_strong', error: err.message })
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Log levels with numeric priorities
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4
};

const LEVEL_NAMES = Object.keys(LOG_LEVELS);

/**
 * Structured Logger Class
 * Manages all logging across the bot with context and proper formatting
 */
class Logger {
  constructor(config = {}) {
    this.config = {
      level: config.level || 'info',
      format: config.format || 'json', // 'json' or 'text'
      console: config.console !== false,
      file: {
        enabled: config.file?.enabled ?? true,
        path: config.file?.path || './logs/bot.log',
        maxSize: this.parseSize(config.file?.maxSize || '10m'),
        maxFiles: config.file?.maxFiles || 5
      },
      modules: config.modules || {}
    };

    this.levelThreshold = LOG_LEVELS[this.config.level.toUpperCase()] || LOG_LEVELS.INFO;
    this.logs = []; // In-memory buffer for dashboard
    this.maxBufferSize = 500;
    
    // Ensure log directory exists
    if (this.config.file.enabled) {
      this.ensureLogDirectory();
    }
  }

  /**
   * Parse size strings like "10m", "100k" into bytes
   */
  parseSize(sizeStr) {
    const units = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
    const match = String(sizeStr).match(/^(\d+)([kmg])?$/i);
    if (!match) return 10 * 1024 * 1024; // Default 10MB
    return parseInt(match[1]) * (units[match[2]?.toLowerCase()] || 1);
  }

  /**
   * Ensure log directory exists
   */
  ensureLogDirectory() {
    const dir = path.dirname(this.config.file.path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Get log level number for a module
   * Falls back to default level if module not specified
   */
  getModuleLevel(module) {
    if (this.config.modules[module]) {
      return LOG_LEVELS[this.config.modules[module].toUpperCase()] || this.levelThreshold;
    }
    return this.levelThreshold;
  }

  /**
   * Main logging method
   * @param {string} level - Log level (DEBUG, INFO, WARN, ERROR, FATAL)
   * @param {string} context - Context string (e.g., "movement.pathfind")
   * @param {object} data - Data object to log
   */
  log(level, context, data = {}) {
    const levelNum = LOG_LEVELS[level.toUpperCase()];
    if (levelNum === undefined) {
      console.error(`[Logger] Invalid log level: ${level}`);
      return;
    }

    // Check module-specific level
    const [module] = context.split('.');
    const moduleLevel = this.getModuleLevel(module);
    
    if (levelNum < moduleLevel) {
      return; // Skip this log
    }

    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      context,
      data,
      id: Date.now() + Math.random()
    };

    // Store in memory buffer
    this.logs.push(logEntry);
    if (this.logs.length > this.maxBufferSize) {
      this.logs.shift(); // Remove oldest
    }

    // Format and output
    const formatted = this.formatLog(logEntry);

    if (this.config.console) {
      this.outputConsole(level, formatted);
    }

    if (this.config.file.enabled) {
      this.outputFile(formatted);
    }
  }

  /**
   * Format log entry based on configured format
   */
  formatLog(entry) {
    if (this.config.format === 'json') {
      return JSON.stringify(entry);
    } else {
      // Text format: [TIME] [LEVEL] context: data
      return `[${entry.timestamp.split('T')[1].split('Z')[0]}] [${entry.level.padEnd(5)}] ${entry.context}: ${JSON.stringify(entry.data)}`;
    }
  }

  /**
   * Output to console with color coding
   */
  outputConsole(level, formatted) {
    const colors = {
      DEBUG: '\x1b[36m', // Cyan
      INFO: '\x1b[32m',  // Green
      WARN: '\x1b[33m',  // Yellow
      ERROR: '\x1b[31m', // Red
      FATAL: '\x1b[35m'  // Magenta
    };
    const reset = '\x1b[0m';
    
    const color = colors[level] || '';
    console.log(`${color}${formatted}${reset}`);
  }

  /**
   * Output to file with rotation support
   */
  outputFile(formatted) {
    try {
      // Check file size and rotate if needed
      if (fs.existsSync(this.config.file.path)) {
        const stats = fs.statSync(this.config.file.path);
        if (stats.size > this.config.file.maxSize) {
          this.rotateLogFile();
        }
      }

      // Append to log file
      fs.appendFileSync(this.config.file.path, formatted + '\n', 'utf8');
    } catch (error) {
      console.error('[Logger] Failed to write to log file:', error.message);
    }
  }

  /**
   * Rotate log files when they get too large
   */
  rotateLogFile() {
    const dir = path.dirname(this.config.file.path);
    const base = path.basename(this.config.file.path, path.extname(this.config.file.path));
    const ext = path.extname(this.config.file.path);

    // Delete oldest file if we have too many
    for (let i = this.config.file.maxFiles; i >= 1; i--) {
      const oldFile = path.join(dir, `${base}.${i}${ext}`);
      if (fs.existsSync(oldFile) && i >= this.config.file.maxFiles) {
        fs.unlinkSync(oldFile);
      }
    }

    // Shift all numbered files up by one
    for (let i = this.config.file.maxFiles - 1; i >= 1; i--) {
      const oldFile = path.join(dir, `${base}.${i}${ext}`);
      const newFile = path.join(dir, `${base}.${i + 1}${ext}`);
      if (fs.existsSync(oldFile)) {
        fs.renameSync(oldFile, newFile);
      }
    }

    // Rename current file to .1
    const currentFile = this.config.file.path;
    const newFile = path.join(dir, `${base}.1${ext}`);
    if (fs.existsSync(currentFile)) {
      fs.renameSync(currentFile, newFile);
    }
  }

  /**
   * Convenience methods for each log level
   */
  debug(context, data) { this.log('DEBUG', context, data); }
  info(context, data) { this.log('INFO', context, data); }
  warn(context, data) { this.log('WARN', context, data); }
  error(context, data) { this.log('ERROR', context, data); }
  fatal(context, data) { this.log('FATAL', context, data); }

  /**
   * Get recent logs for dashboard
   * @param {number} count - Number of recent logs to return
   * @returns {array} Recent log entries
   */
  getRecentLogs(count = 100) {
    return this.logs.slice(-count);
  }

  /**
   * Get logs by level
   */
  getLogsByLevel(level) {
    return this.logs.filter(log => log.level === level);
  }

  /**
   * Clear log buffer
   */
  clear() {
    this.logs = [];
  }

  /**
   * Get logger stats
   */
  getStats() {
    return {
      totalLogs: this.logs.length,
      byLevel: {
        DEBUG: this.logs.filter(l => l.level === 'DEBUG').length,
        INFO: this.logs.filter(l => l.level === 'INFO').length,
        WARN: this.logs.filter(l => l.level === 'WARN').length,
        ERROR: this.logs.filter(l => l.level === 'ERROR').length,
        FATAL: this.logs.filter(l => l.level === 'FATAL').length
      }
    };
  }
}

// Create and export singleton instance
const logger = new Logger({
  level: 'info',
  format: 'json',
  console: true,
  file: {
    enabled: true,
    path: './logs/bot.log',
    maxSize: '10m',
    maxFiles: 5
  }
});

export default logger;
