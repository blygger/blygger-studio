// When the built-in digest is written (Settings → AI → agentic feed, session 90): by the clock,
// on the quarter-hour cron, so a quiet node keeps no record of when it last ran.

/** The hour, in the owner's timezone, of a daily or weekly digest; a weekly one is written on Mondays. */
export const DIGEST_HOUR = 7;

/**
 * Whether the quarter-hour tick at `at` is the one that writes a digest at this frequency: the
 * first tick of each hour, of 07:00 each day, or of 07:00 on Mondays, in `timeZone`. Read from the
 * clock, so a quiet node keeps no record of when it last ran.
 */
export function digestDue(frequency: "hourly" | "daily" | "weekly", at: Date, timeZone: string): boolean {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(at).map((p) => [p.type, p.value]));
  if (Number(parts.minute) >= 15) return false;
  if (frequency === "hourly") return true;
  return Number(parts.hour) === DIGEST_HOUR && (frequency === "daily" || parts.weekday === "Mon");
}
