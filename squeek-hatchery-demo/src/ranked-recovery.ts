import type { LedSession } from "./led-session.ts";

/** Recover from interruption through the server, never by reusing old locks. */
export async function restoreRankedAttempt<T>({
  readActive, restart, resetUnfinished, isCurrent,
}: {
  readActive: () => Promise<{ session: LedSession | null; allowance?: T }>;
  restart: (sessionId: string) => Promise<{ session: LedSession; allowance?: T }>;
  resetUnfinished: boolean;
  isCurrent: () => boolean;
}): Promise<{ session: LedSession | null; allowance?: T } | null> {
  const active = await readActive();
  if (!isCurrent()) return null;
  if (!resetUnfinished || !active.session || active.session.status === "completed") return active;

  const reset = await restart(active.session.id);
  if (!isCurrent()) return null;
  if (reset.session.id !== active.session.id || reset.session.familyIndex !== active.session.familyIndex ||
      reset.session.status !== "egg" || reset.session.elapsed !== 0 || reset.session.lockedTraits !== null ||
      reset.session.regions.some(region => region.level !== 0 || region.dose !== 0 || region.exposure !== 0)) {
    throw new Error("The server did not clear the interrupted attempt on the same egg.");
  }
  return { session: reset.session, allowance: reset.allowance ?? active.allowance };
}
