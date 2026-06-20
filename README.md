# NEKO Bot 🐱⛏️

A sassy, autonomous Minecraft bot built on Mineflayer. NEKO is a girl who explores, mines, crafts, fights (when she feels confident), builds a base, remembers everyone she meets, and learns from her own mistakes - she progresses from punching trees to diamond tools on her own.

## Quick Start (local)

```bash
npm install
cp .env.example .env   # then fill in your real values
npm start
```

## Deploying on Railway

1. Push this repo to GitHub.
2. Create a new Railway project from that GitHub repo.
3. In Railway → Variables, set:
   - `MC_HOST` - your Minecraft server address
   - `MC_PORT` - your Minecraft server port
   - `MC_VERSION` - e.g. `1.20.1`
   - `MC_USERNAME` - the bot's in-game name
   - `GROQ_API_KEY` - your Groq API key (get one at https://console.groq.com)
   - Railway sets `PORT` automatically - don't set it manually.
4. Deploy. Railway runs `npm start` automatically.
5. Check `https://<your-app>.up.railway.app/health` to confirm NEKO is connected.

**Never commit a real `.env` file or paste API keys in chat/issues** - `.gitignore` already excludes `.env`, keep it that way.

## Project Structure

```
src/
  config.js              # Single source of truth: settings.json + env vars merged
  index.js                # Entry point: connects, loads plugins, wires everything together

  core/                   # Pre-existing foundation (Logger, EventBus, ErrorHandler, Goal, PlayerState)

  memory/
    Memory.js             # Persistent JSON memory - players, base, inventory, locations, confidence

  chat/
    personality.js        # NEKO's character definition (system prompt for Groq)
    GroqClient.js          # Groq API wrapper with timeout + template fallbacks
    ChatHandler.js          # Routes player chat -> commands / actions / AI responses

  ai/
    actions.js             # Shared craft/mine/gather/smelt mechanics (used by chat AND goals)
    GoalSelector.js          # Decision tree: what should NEKO do right now?
    GoalManager.js            # Tick loop that runs whatever GoalSelector picks
    goals/
      SurvivalGoals.js        # FleeGoal, EatGoal (highest priority)
      CombatGoals.js           # AttackGoal (fight when learned strategy says to)
      ProgressionGoals.js       # GatherWood, Craft, MineOre, Smelt, Explore
      BuildBaseGoal.js           # Basic starter shelter

  systems/
    ExperienceRecorder.js   # Records events, detects death/threat patterns
    StrategyAdaptor.js      # Turns patterns into actual behavior changes
    Behavior.js              # Tracks "what is NEKO doing right now" for !status
    EventReactions.js        # Wires real game events to reactive chat + learning
```

## How NEKO decides what to do

Every 5 seconds, `GoalManager` asks `GoalSelector` for the next goal:

1. **Survival always wins** - critical health or a nearby threat overrides everything.
2. **Fight or flee** is decided per-mob using learned history (`StrategyAdaptor`) - she'll keep fleeing specific mobs she's lost to before, even if generally confident. Creepers are always treated as flee-only for safety.
3. **Progression** - wood → crafting table → wooden tools → stone tools → furnace → iron tools → diamond tools → base, each stage checked against current inventory.
4. **Otherwise, explore** - and remember any structures (villages, dungeons) stumbled upon along the way.

A player's direct chat request (e.g. "mine some iron") temporarily pauses the autonomous loop so NEKO doesn't fight the request.

See `ROADMAP.md` for what's intentionally **not** built yet.
