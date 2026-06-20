/**
 * NEKO Chat Handler
 *
 * WHAT CHANGED FROM YOUR REFERENCE FILE:
 *  1. Converted from CommonJS (require/module.exports) to ESM (import/export),
 *     since package.json declares "type": "module".
 *  2. require('./memory'), require('./nekoAI') etc. pointed at files that
 *     didn't exist - now imports real modules: Memory.js, GroqClient.js,
 *     StrategyAdaptor.js, ExperienceRecorder.js, Behavior.js.
 *  3. require('minecraft-data') and require('mineflayer-pathfinder') inside
 *     async functions are now proper ESM imports at the top of the file
 *     (require() doesn't exist in ESM at all - this would have crashed
 *     immediately on first use).
 *  4. Everything else - the action-intent parsing (craft/mine/follow/come/
 *     stop), commands, situation detection, event reactions - is preserved
 *     from your original logic, just adapted to the new module APIs.
 *
 * This is the file that gets wired to bot.on('chat', ...) in index.js.
 */

import pathfinderPkg from 'mineflayer-pathfinder';

import memory from '../memory/Memory.js';
import groqClient from './GroqClient.js';
import strategyAdaptor from '../systems/StrategyAdaptor.js';
import experienceRecorder from '../systems/ExperienceRecorder.js';
import nekoBehavior from '../systems/Behavior.js';
import logger from '../core/Logger.js';
import * as actions from '../ai/actions.js';
import goalManager from '../ai/GoalManager.js';

const { goals } = pathfinderPkg;

class NekoChatHandler {
  constructor() {
    this.chatHistory = [];
    this.followTarget = null;
    this.followInterval = null;
    this.eventCooldowns = {
      death: 0,
      damage: 0,
      mob: 0,
      mining: 0
    };
  }

  /**
   * Main chat handler - process player messages and generate NEKO responses
   */
  async handlePlayerChat(playerName, message, bot) {
    try {
      // Check if message is a command
      if (message.startsWith('!')) {
        return await this.handleCommand(playerName, message, bot);
      }

      // Check if message is an actionable request (craft/mine/come/follow/stop)
      // before falling through to plain conversational AI - this is what
      // actually makes NEKO DO things players ask for, not just talk about it.
      const actionResult = await this.handleActionIntent(playerName, message, bot);
      if (actionResult !== null) {
        memory.recordPlayerInteraction(playerName, message, actionResult);
        return actionResult;
      }

      // Detect if player is telling NEKO their name
      const nameMatch = message.match(/my name is (\w+)|call me (\w+)|ami (\w+)|amare (\w+) dako|amake (\w+) bolo/i);
      if (nameMatch) {
        const nickname = nameMatch[1] || nameMatch[2] || nameMatch[3] || nameMatch[4] || nameMatch[5];
        memory.saveNickname(playerName, nickname);
        const response = `Got it, I'll call you ${nickname} from now on 😏`;
        memory.recordPlayerInteraction(playerName, message, response);
        return response;
      }

      // Get memory context
      const memoryContext = memory.getMemoryContext();

      // Build conversation context
      const recentChat = this.chatHistory.slice(-5).map((msg) => ({
        role: msg.role,
        content: msg.content
      }));

      // Check for special situations
      const situation = this.detectSituation(message);

      // Use quick response for common situations (saves API calls on
      // predictable small talk)
      if (situation && Math.random() > 0.4) {
        const quickResponse = groqClient.getQuickResponse(situation, memoryContext, playerName);
        memory.recordPlayerInteraction(playerName, message, quickResponse);
        return quickResponse;
      }

      // Use nickname if player has set one, and look up special-player
      // personality (creator / roast target / rizz target) from memory
      const displayName = memory.getDisplayName(playerName);
      const specialRole = memory.data.specialPlayers[playerName] || null;

      // Use AI for varied responses
      const aiResponse = await groqClient.generateResponse(
        playerName,
        message,
        memoryContext,
        recentChat,
        displayName,
        specialRole
      );

      // Record interaction
      memory.recordPlayerInteraction(playerName, message, aiResponse);

      // Add to chat history
      this.addToHistory('user', `${playerName}: ${message}`);
      this.addToHistory('assistant', aiResponse);

      // Learn from interaction (detect if player seems to like NEKO)
      this.learnFromInteraction(playerName, message, aiResponse);

      return aiResponse;
    } catch (error) {
      logger.error('chat.handler_error', { error: error.message });
      return "Eh something broke, my bad 😅";
    }
  }

  /**
   * ============================================================
   * ANALYZE GAME EVENTS
   * Handles: death, damage, mobs, mining, discovery
   * ============================================================
   */
  async analyzeGameEvent(event) {
    const { type, data } = event;
    const now = Date.now();

    const cooldownTimes = { death: 60000, damage: 20000, mob: 25000, mining: 15000 };
    if (this.eventCooldowns[type] && (now - this.eventCooldowns[type]) < (cooldownTimes[type] || 20000)) {
      return { shouldChat: false, reason: 'cooldown' };
    }

    try {
      let message = null;
      let shouldChat = true;

      switch (type) {
        case 'death':
          message = `Nah I'm not out, I'll be back.`;
          memory.data.daysAlive = 0;
          memory.data.totalDeaths += 1;
          memory.saveMemory();
          break;

        case 'damage':
          if (data.health < 4) {
            message = `Gotta find food NOW.`;
            memory.recordNearDeath();
          } else {
            shouldChat = false;
          }
          break;

        case 'mob_encounter': {
          const confidence = memory.data.confidenceLevel || 0;
          const dangerousMobs = ['creeper', 'enderman', 'cave_spider', 'phantom'];
          const isDangerous = (data.mobs || []).some((m) =>
            dangerousMobs.some((d) => m.name.toLowerCase().includes(d))
          );

          experienceRecorder.record('combat', { mobs: data.mobs, confidence });

          if (isDangerous || confidence > 50) {
            message = confidence > 60 ? 'Time for a fight.' : 'Nope, bouncing!';
          } else {
            shouldChat = false;
          }
          break;
        }

        case 'mining_success': {
          const valuableOres = ['diamond', 'emerald', 'ancient_debris', 'gold', 'deepslate_diamond'];
          experienceRecorder.record('mining', { ore: data.ore, quantity: data.quantity });

          if (valuableOres.some((ore) => data.ore.includes(ore))) {
            message = `${data.ore.toUpperCase()}!! Going in my collection 💎`;
            memory.collectItem(data.ore, data.quantity || 1);
          } else {
            shouldChat = false;
          }
          break;
        }

        default:
          shouldChat = false;
      }

      if (shouldChat && message) {
        this.eventCooldowns[type] = now;
        return { shouldChat: true, message, eventType: type };
      }

      return { shouldChat: false, reason: 'filtered' };
    } catch (err) {
      // Fail silently to prevent error spam in chat/logs
      logger.warn('chat.event_analysis_error', { type, error: err.message });
      return { shouldChat: false, reason: 'error' };
    }
  }

  /**
   * ============================================================
   * ACTION INTENT PARSER
   * Detects plain-English requests like "make a wooden pickaxe",
   * "mine some iron", "come here", "follow me", "stop" and executes
   * them on the live bot instead of just chatting about it.
   * Returns a reply string if it handled an action, or null if the
   * message wasn't recognized as an action (so the normal AI chat
   * path can take over).
   * ============================================================
   */
  async handleActionIntent(playerName, message, bot) {
    const lower = message.toLowerCase().trim();

    try {
      // --- STOP / CANCEL ---
      if (/^(stop|cancel|halt|wait)\b/.test(lower)) {
        if (bot.pathfinder) bot.pathfinder.setGoal(null);
        this.followTarget = null;
        goalManager.pauseFor(10000); // give the player breathing room before NEKO resumes autonomy
        return `Okay, stopping ⏸️`;
      }

      // --- COME HERE ---
      if (/\b(come here|come to me|cmere|get over here)\b/.test(lower)) {
        goalManager.pauseFor(15000);
        return await this.actionComeHere(playerName, bot);
      }

      // --- FOLLOW ME ---
      if (/\b(follow me|follow him|follow her)\b/.test(lower)) {
        goalManager.pauseFor(60000); // following lasts longer, give it more room
        return await this.actionFollow(playerName, bot);
      }

      // --- CRAFT / MAKE ---
      let m = lower.match(/\b(?:craft|make)\s+(?:me\s+)?(?:a|an|some)?\s*([a-z_\s]+?)(?:\s+please)?[.!?]?$/);
      if (m) {
        goalManager.pauseFor(15000);
        return await this.actionCraft(m[1].trim(), bot);
      }

      // --- MINE / GET / FIND ore ---
      m = lower.match(/\b(?:mine|get|find|dig up)\s+(?:me\s+)?(?:some|a|an)?\s*([a-z_\s]+?)(?:\s+ore)?(?:\s+please)?[.!?]?$/);
      if (m) {
        goalManager.pauseFor(30000);
        return await this.actionMine(m[1].trim(), bot);
      }

      return null; // not an action - let normal chat handling run
    } catch (err) {
      logger.warn('chat.action_intent_error', { error: err.message });
      return null; // fall back to normal chat on unexpected errors
    }
  }

  async actionComeHere(playerName, bot) {
    const result = await actions.comeToPlayer(bot, playerName);
    return result.message;
  }

  async actionFollow(playerName, bot) {
    const player = bot.players[playerName]?.entity;
    if (!player) return `I can't see you right now 🤔`;
    if (!bot.pathfinder) return `My pathfinder isn't ready yet, give me a sec.`;

    this.followTarget = playerName;

    if (this.followInterval) clearInterval(this.followInterval);
    this.followInterval = setInterval(() => {
      if (this.followTarget !== playerName) {
        clearInterval(this.followInterval);
        return;
      }
      const p = bot.players[playerName]?.entity;
      if (p && bot.pathfinder) {
        bot.pathfinder.setGoal(new goals.GoalFollow(p, 2), true);
      }
    }, 1000);
    // Don't let the follow-loop keep the process alive on its own.
    this.followInterval.unref?.();

    return `Following you! Say "stop" anytime 👣`;
  }

  async actionCraft(itemNameRaw, bot) {
    const result = await actions.craftItem(bot, itemNameRaw);
    return result.message;
  }

  async actionMine(oreNameRaw, bot) {
    const result = await actions.mineOre(bot, oreNameRaw);
    return result.message;
  }

  /**
   * Handle special commands
   */
  async handleCommand(playerName, message, bot) {
    const [cmd, ...args] = message.slice(1).toLowerCase().split(' ');

    const commands = {
      learn: () => {
        const r = strategyAdaptor.getAdaptationReport();
        const level = isNaN(r.adaptationLevel) ? 0 : r.adaptationLevel;
        return `📚 Learning: ${level}/10 | Mobs: ${r.knownDangerousMobs} | Zones: ${r.knownSafeZones}`;
      },
      knowledge: () => {
        const s = experienceRecorder.getStats();
        return `🧠 Experiences: ${s.totalEvents} | Mining: ${s.miningEvents} | Combat: ${s.combatEvents}`;
      },
      strategy: () => {
        const m = strategyAdaptor.getMiningStrategy();
        const c = strategyAdaptor.getCombatStrategy();
        return `⚡ Mine Y:${m.targetYLevel} | Fight: ${c.preferredTactic} | Aggression: ${c.aggressiveness}/10`;
      },
      status: () => this.getStatus(),
      base: () => this.getBaseInfo(),
      inventory: () => this.getInventoryInfo(),
      help: () => this.getHelpMessage(),
      stats: () => this.getStats(playerName),
      confidence: () => `Confidence: ${memory.getConfidenceLevel()} (${Math.round(memory.data.confidenceLevel)}%)`,
      collect: () => `Collected so far: ${memory.data.base.resourcesCollected} items! Let's gooo 💎`,
      where: () => `Building at: ${memory.data.base.location || 'Haven\'t found a spot yet'}`
    };

    const response = commands[cmd] ? commands[cmd]() : this.getHelpMessage();
    memory.recordPlayerInteraction(playerName, message, response);
    return response;
  }

  /**
   * Detect special situations in chat.
   *
   * BUG FIX: the original version used lower.includes('hi'), which
   * falsely matched words like "think" or "machine" (both contain "hi"
   * as a substring). Switched to word-boundary regex matching so only
   * whole words trigger a situation.
   */
  detectSituation(message) {
    const lower = message.toLowerCase();

    const matches = (words) => {
      const pattern = new RegExp(`\\b(${words.join('|')})\\b`);
      return pattern.test(lower);
    };

    if (matches(['hi', 'hello', 'yo', 'hey'])) {
      return 'greeting';
    }
    if (matches(['diamond', 'diamonds', 'gold', 'rare'])) {
      return 'collector';
    }
    if (matches(['creeper', 'creepers', 'mob', 'mobs', 'help'])) {
      return 'danger';
    }
    if (matches(['nice', 'cool', 'awesome', 'lol'])) {
      return 'celebration';
    }
    return null;
  }

  /**
   * Learn player interactions to improve future responses
   */
  learnFromInteraction(playerName, playerMessage, response) {
    const player = memory.data.players[playerName];
    if (!player) return;

    const messageWords = playerMessage.toLowerCase().split(' ');
    const appreciationWords = ['thanks', 'thank', 'good', 'nice', 'cool', 'awesome', 'lol', 'haha', 'funny'];
    const hasAppreciation = messageWords.some((word) => appreciationWords.includes(word));

    if (hasAppreciation) {
      player.likes.push({ message: playerMessage, timestamp: Date.now() });
    }
  }

  /**
   * Get status report
   */
  getStatus() {
    const uptime = Math.floor((Date.now() - memory.data.lastSurvivalCheck) / 1000 / 60);
    const confidence = memory.getConfidenceLevel();

    return `📊 NEKO STATUS:
▸ Confidence: ${confidence} (${Math.round(memory.data.confidenceLevel)}%)
▸ Uptime: ${uptime}+ minutes
▸ Base: ${memory.data.base.upgrades[memory.data.base.upgrades.length - 1]}
▸ Items: ${memory.data.base.resourcesCollected} collected
▸ Currently: ${nekoBehavior.getActivityDescription()}`;
  }

  /**
   * Get base info
   */
  getBaseInfo() {
    const baseList = memory.data.base.upgrades.join(' → ');
    const nextUpgrade = memory.data.base.nextUpgrade;

    return `🏰 MY BASE:
▸ Built: ${baseList}
▸ Next Goal: ${nextUpgrade}
▸ Location: ${memory.data.base.location || 'Still scouting'}
▸ Room for UPGRADES: YES 🔥`;
  }

  /**
   * Get inventory info
   */
  getInventoryInfo() {
    const inv = memory.data.inventory;
    let report = `💎 MY COLLECTION:\n`;

    for (const [item, count] of Object.entries(inv)) {
      if (item !== 'other' && count > 0) {
        report += `▸ ${item}: ${count}\n`;
      }
    }

    if (Object.keys(inv.other).length > 0) {
      report += `▸ Other: ${Object.keys(inv.other).length} types\n`;
    }

    return report;
  }

  /**
   * Get stats for a player
   */
  getStats(playerName) {
    const playerData = memory.data.players[playerName];

    if (!playerData) {
      return `No data on ${playerName} yet. Say hi! 👋`;
    }

    const interactionCount = playerData.interactions.length;
    const firstSeen = new Date(playerData.firstSeen).toLocaleDateString();

    return `📈 STATS FOR ${playerName}:
▸ First seen: ${firstSeen}
▸ Interactions: ${interactionCount}
▸ Likes: ${playerData.likes.length}
▸ Dislikes: ${playerData.dislikes.length}`;
  }

  /**
   * Help message
   */
  getHelpMessage() {
    return `🤖 NEKO COMMANDS:
▸ !status - My current status
▸ !base - My base info
▸ !inventory - What I collected
▸ !confidence - Confidence level
▸ !stats [player] - Stats about you
▸ !where - Where I'm building
▸ Just chat normally - I'll respond! 💬`;
  }

  /**
   * Add to local chat history
   */
  addToHistory(role, content) {
    this.chatHistory.push({ role, content, timestamp: Date.now() });
    if (this.chatHistory.length > 20) {
      this.chatHistory.shift();
    }
  }

  /**
   * Generate a random NEKO thought/action in chat
   */
  getRandomThought() {
    const thoughts = [
      "just realized diamonds are kinda pretty ngl 💎",
      "wondering if I can beat the Ender Dragon fr fr 🐉",
      "thinking about my base design... gonna be LEGENDARY",
      "creepers are so annoying man",
      "lowkey obsessed with collecting everything I see 📦",
      "bet I can out-mine any player on this server",
      "wondering what's beyond the mountains... EXPLORING TIME!",
      "my confidence is 📈 and my fear is 📉"
    ];
    return `* NEKO is ${thoughts[Math.floor(Math.random() * thoughts.length)]}`;
  }

  /**
   * React to game events
   */
  async reactToGameEvent(eventType, data) {
    const reactions = {
      mob_defeated: `YESSS just destroyed that ${data.mobType}! 💪 I'm getting STRONGER`,
      found_ore: `Found ${data.ore}! Going straight to my collection! 🏛️`,
      took_damage: `OWW that hurt!! But I'm not dying today 😤`,
      found_player: `Yo ${data.playerName}! Didn't know you were here!`,
      built_block: `Another block for my masterpiece! 🧱`,
      died: `NOOOOO I DIEDDD!! But I'll be back stronger fr fr 💪`
    };
    return reactions[eventType] || 'Something interesting happened...';
  }
}

const nekoChatHandler = new NekoChatHandler();
export default nekoChatHandler;
