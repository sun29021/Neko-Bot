# NEKO Bot - Roadmap

This is an honest accounting of what's built, what's deliberately simplified, and what's not built yet - written so the next development session (or another contributor) doesn't have to rediscover gaps by trial and error.

## ✅ Built and tested (Phases 1-6)

- Config system (settings.json + env vars, secrets never in committed files)
- Auto-reconnect with exponential backoff
- Persistent memory (players, nicknames, confidence, inventory, locations, base progress) - survives restarts
- Sassy-girl personality via Groq API, with template fallback if the API is down/unset
- Action-intent parsing from natural chat (craft/mine/come/follow/stop)
- Goal-based AI: wood → crafting table → wooden tools → stone tools → furnace → iron tools (with smelting) → diamond tools → starter base
- Survival: flee danger, auto-eat when hungry, creeper-safe combat logic
- Learning: tracks dangerous Y-levels (avoids depths that killed her before) and per-mob threat ranking (keeps avoiding mobs she's lost to, independent of overall confidence)
- Basic combat (melee, with automatic disengage at low health)
- Exploration with structure detection (chests/beds/spawners → remembers village/dungeon locations)
- Reactive chat for real game events (damage, death, mob encounters)

## ⚠️ Known limitations / deliberately simplified

These aren't bugs - they're scope boundaries I'm flagging explicitly rather than letting you discover them later:

- **Base building is minimal.** `BuildBaseGoal` places a single starter wall block and remembers the location - it is not a structure planner. No farms, no storage organization, no architectural variety.
- **Base building triggers late.** Because `GoalSelector`'s progression stages return early, base-building only becomes reachable after full diamond tools are obtained, not interleaved earlier. Easy to change if you want NEKO settling down sooner - see "Next steps" below.
- **Combat is melee-only**, no bow/crossbow usage, no shield blocking, no multi-mob kiting strategy.
- **Smelting** only handles iron currently (`SmeltGoal` is generic, but `GoalSelector` only invokes it for iron) - gold smelting isn't wired into the progression stages yet.
- **No farming** (crops, animal breeding) for sustainable food - currently relies entirely on `mineflayer-auto-eat` consuming whatever food happens to be in inventory.
- **No Nether or End progression.** Diamond tools is the current ceiling - no portal building, no blaze/ghast handling, no Ender Dragon fight logic.
- **Structure detection is indirect.** Mineflayer doesn't expose "you're near a village" directly, so detection is based on spotting indicator blocks (beds, chests, spawners) within 24 blocks - it won't notice a structure it never gets close to.

## 🗺️ Suggested next steps, in priority order

1. **Gold smelting + gold tool stage** - same pattern as iron, just needs a `GoalSelector` stage added.
2. **Earlier/incremental base building** - move the base-building check earlier in `getProgressionGoal()` (e.g. right after stone tools) so NEKO starts a shelter before fully tooling up, rather than only after diamond tools.
3. **Simple farming goal** - plant/harvest wheat near the base once a base location exists, for sustainable food instead of relying purely on found food.
4. **Ranged combat** - equip and use a bow against skeletons specifically (currently she can only flee or melee them).
5. **Nether portal + basic Nether survival** - obsidian mining, portal building, careful exploration (lava/ghast avoidance reuses the existing `FleeGoal`/danger-detection patterns).
6. **Base expansion goals** - once a base exists, periodically add storage chests, a bed, lighting (mob-spawn prevention) as their own small goals.
7. **Ender Dragon prep** - eye-of-ender gathering, stronghold-finding (the `end_portal_frame` structure indicator is already wired into `ExploreGoal` for this).

## Testing notes for whoever continues this

Most of this codebase was verified with mocked `bot`/`playerState` objects rather than a live Minecraft connection (sandboxed dev environment had no route to the target server). Before trusting new autonomous behavior in production:
- Watch the Railway logs during the bot's first 10-15 minutes live.
- The `!status`, `!learn`, `!knowledge`, and `!strategy` chat commands are useful for checking what NEKO currently believes about herself without needing to read logs.
