/**
 * NEKO Groq Client
 *
 * WHAT THIS FILE DOES:
 * Thin wrapper around the groq-sdk that:
 *  1. Builds the personality-aware prompt (via personality.js)
 *  2. Calls the Groq API with a timeout (so a slow/hung API call can't
 *     freeze the bot's chat response forever)
 *  3. Falls back to template responses if the API key is missing, the
 *     call fails, or it times out - the bot should NEVER go silent in
 *     chat just because the AI provider had a hiccup.
 *
 * This is intentionally the ONLY file that talks to Groq directly -
 * everything else goes through generateResponse() / getQuickResponse().
 */

import Groq from 'groq-sdk';
import config from '../config.js';
import logger from '../core/Logger.js';
import errorHandler, { APIError, TimeoutError } from '../core/ErrorHandler.js';
import { buildSystemPrompt } from './personality.js';

// Only construct the client if we actually have a key - calling the SDK
// with an empty key would throw on every single request.
const groqClient = config.ai.chat.apiKey ? new Groq({ apiKey: config.ai.chat.apiKey }) : null;

// ============================================================
// FALLBACK TEMPLATES
// Used when the API is unavailable - keeps NEKO "alive" in chat
// even if Groq is down or the key is missing/rate-limited.
// ============================================================
const FALLBACK_TEMPLATES = {
  greeting: [
    'yo what\'s up 👋',
    'sup! good to see you',
    'heyyy 😏'
  ],
  collector: [
    'ooh you collecting too? I\'m always on the hunt for diamonds 💎',
    'I see you, fellow loot goblin'
  ],
  danger: [
    'careful out there, mobs are no joke',
    'you good? stay sharp'
  ],
  celebration: [
    'heck yeah! 🔥',
    'lol facts',
    'lets gooo'
  ],
  generic: [
    'real',
    'lol fair enough',
    'hmm interesting',
    'wait fr?',
    'haha yeah'
  ]
};

/**
 * Picks a random template response for a given situation key (or generic
 * if the situation isn't recognized / none provided).
 */
function getTemplateResponse(situation = 'generic') {
  const pool = FALLBACK_TEMPLATES[situation] || FALLBACK_TEMPLATES.generic;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Wraps a promise with a timeout, rejecting with TimeoutError if it
 * takes longer than `ms` to resolve.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`Groq request exceeded ${ms}ms`)), ms);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Generates a full AI response for a chat message.
 * Falls back to a template response on any failure.
 *
 * @param {string} playerName - the player's raw Minecraft username
 * @param {string} message - what they said
 * @param {object} memoryContext - from memory.getMemoryContext()
 * @param {array} recentChat - last few {role, content} messages for context
 * @param {string} displayName - nickname to address them by
 * @param {object|null} specialRole - from memory.data.specialPlayers[playerName]
 */
export async function generateResponse(playerName, message, memoryContext, recentChat = [], displayName = playerName, specialRole = null) {
  // No API key configured - go straight to fallback, don't even try.
  if (!groqClient) {
    return getTemplateResponse('generic');
  }

  try {
    const systemPrompt = buildSystemPrompt({ playerName, displayName, memoryContext, specialRole });

    const messages = [
      { role: 'system', content: systemPrompt },
      ...recentChat,
      { role: 'user', content: `${playerName}: ${message}` }
    ];

    const completion = await withTimeout(
      groqClient.chat.completions.create({
        model: config.ai.chat.model,
        messages,
        temperature: config.ai.chat.temperature,
        max_tokens: config.ai.chat.maxTokens
      }),
      config.ai.chat.timeout
    );

    const reply = completion.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      throw new APIError('Groq returned an empty response');
    }

    return reply;
  } catch (err) {
    // Report through the central error handler (this is where the
    // 'API_ERROR' / 'TIMEOUT' recovery strategies from ErrorHandler.js
    // get used) and fall back to a template so chat never goes silent.
    await errorHandler.report(err, { context: 'chat.groq_request', playerName });
    logger.warn('chat.fallback_used', { reason: err.message });
    return getTemplateResponse('generic');
  }
}

/**
 * Quick, cheap response for common situations (greetings, danger, etc.)
 * without calling the AI at all - used by the chat handler to save API
 * calls on predictable small talk.
 */
export function getQuickResponse(situation, memoryContext, playerName) {
  return getTemplateResponse(situation);
}

export default { generateResponse, getQuickResponse };
