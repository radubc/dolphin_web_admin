/**
 * Whether this process runs the integration scheduler.
 *
 * A module of its own, and deliberately dependency-free, because two things
 * need the answer and they cannot import each other: `./scheduler.ts` sets it
 * when it starts the timer, and `./service.ts` reads it for the
 * `schedulerActive` field of the list response. Importing the scheduler from
 * the service (which the scheduler itself imports to start a run) would be a
 * cycle, and importing it for a boolean would also drag Prisma into every
 * caller.
 *
 * The flag lives on `globalThis` under a symbol: Next's dev server
 * re-evaluates modules on hot reload, and a plain module-level `let` would
 * reset to `false` while the timer from the previous evaluation is still
 * running.
 */

const FLAG = Symbol.for("penny-squeeze.integrations.scheduler.active");

type Holder = { [FLAG]?: boolean };

/** True when `startScheduler()` has installed the timer in this process. */
export function isSchedulerActive(): boolean {
  return (globalThis as Holder)[FLAG] === true;
}

/** Called by `./scheduler.ts` only. */
export function setSchedulerActive(active: boolean): void {
  (globalThis as Holder)[FLAG] = active;
}
