/**
 * NEKO Config Loader
 *
 * WHY THIS FILE EXISTS:
 * Previously, settings.json had one server config and index.js had a
 * DIFFERENT, hardcoded server config — they disagreed with each other,
 * and the API key was sitting in plaintext in settings.json (bad, because
 * settings.json gets committed to GitHub).
 *
 * This file is now the ONLY place that decides final config values.
 * Rule: environment variables (set on Railway, or in a local .env file)
 * always win over settings.json. settings.json holds non-secret defaults
 * and personality/gameplay tuning; secrets and per-deployment values
 * (server host, username) live in env vars.
 *
 * Usage:
 *   import config from './config.js'
 *   console.log(config.server.host)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load .env file if present (for local development).
// On Railway, env vars are injected directly so this is a harmless no-op there.
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = path.join(__dirname, '..', 'settings.json');

// Read the static settings.json file (personality, gameplay tuning, etc.)
let rawSettings = {};
try {
  rawSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (err) {
  console.error('⚠️  Could not read settings.json, using built-in defaults:', err.message);
}

/**
 * Small helper: returns the env var if set, otherwise the fallback value.
 * Keeps the merging logic below readable.
 */
function env(name, fallback) {
  return process.env[name] !== undefined && process.env[name] !== ''
    ? process.env[name]
    : fallback;
}

const config = {
  // ----------------------------------------------------------------
  // Server connection - env vars always win (different per deployment)
  // ----------------------------------------------------------------
  server: {
    host: env('MC_HOST', rawSettings.server?.host || 'localhost'),
    port: parseInt(env('MC_PORT', rawSettings.server?.port || 25565), 10),
    version: env('MC_VERSION', rawSettings.server?.version || '1.20.1')
  },

  account: {
    username: env('MC_USERNAME', rawSettings.account?.username || 'NEKO'),
    type: rawSettings.account?.type || 'offline'
  },

  bot: {
    name: rawSettings.bot?.name || 'NEKO',
    personality: rawSettings.bot?.personality || 'sassy'
  },

  // ----------------------------------------------------------------
  // AI / Chat - the API key NEVER comes from settings.json, only env
  // ----------------------------------------------------------------
  ai: {
    enabled: rawSettings.ai?.enabled !== false,
    chat: {
      enabled: rawSettings.ai?.chat?.enabled !== false,
      provider: 'groq',
      apiKey: env('GROQ_API_KEY', ''),
      model: rawSettings.ai?.chat?.groq?.model || 'llama-3.1-8b-instant',
      temperature: rawSettings.ai?.chat?.groq?.temperature ?? 0.8,
      maxTokens: rawSettings.ai?.chat?.groq?.maxTokens || 120,
      timeout: rawSettings.ai?.chat?.groq?.timeout || 8000
    },
    learning: rawSettings.ai?.learning || { enabled: true },
    goals: rawSettings.ai?.goals || { enabled: true }
  },

  gameplay: rawSettings.gameplay || {},

  memory: {
    persistent: rawSettings.memory?.persistent !== false,
    savePath: rawSettings.memory?.savePath || './data/memory.json',
    autoSave: rawSettings.memory?.autoSave !== false,
    autoSaveInterval: rawSettings.memory?.autoSaveInterval || 60000,
    maxPlayerHistory: rawSettings.memory?.maxPlayerHistory || 100,
    maxInteractionHistory: rawSettings.memory?.maxInteractionHistory || 50,
    specialPlayers: rawSettings.memory?.specialPlayers || {}
  },

  logging: rawSettings.logging || { level: 'info' },

  dashboard: {
    enabled: rawSettings.dashboard?.enabled !== false,
    // Railway injects PORT automatically - that must win over settings.json
    port: parseInt(env('PORT', rawSettings.dashboard?.port || 5000), 10),
    host: '0.0.0.0'
  }
};

// ----------------------------------------------------------------
// Fail loudly (but don't crash) if the Grok API key is missing.
// Chat will fall back to template responses (see Phase 3) instead
// of crashing the whole bot.
// ----------------------------------------------------------------
if (config.ai.chat.enabled && !config.ai.chat.apiKey) {
  console.warn(
    '⚠️  GROQ_API_KEY is not set. NEKO will use fallback chat responses ' +
    'instead of AI-generated ones. Set it in Railway Variables or a local .env file.'
  );
}

export default config;
