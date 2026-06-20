/**
 * NEKO Behavior Tracker
 *
 * PHASE 3 NOTE: Simple singleton holding a human-readable description of
 * what NEKO is currently doing, used by the !status chat command. Phase 4
 * (Goal System) will call setActivity() every time a goal starts/changes,
 * so this description stays accurate without the chat handler needing to
 * know anything about goals directly.
 */

class Behavior {
  constructor() {
    this.currentActivity = 'just spawned in, getting my bearings';
  }

  /**
   * Called by the goal system (Phase 4) whenever NEKO starts a new
   * activity, e.g. setActivity('mining for iron near the cave')
   */
  setActivity(description) {
    this.currentActivity = description;
  }

  /**
   * Used by the !status chat command.
   */
  getActivityDescription() {
    return this.currentActivity;
  }
}

const nekoBehavior = new Behavior();
export default nekoBehavior;
