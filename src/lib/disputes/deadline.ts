/**
 * Stripe's evidence deadline (`evidence_details.due_by`) for people: the alert
 * email and /admin/disputes. Pure — no Resend or server imports — so the
 * browser page can use it.
 *
 * `due_by` is a real instant (often 23:59:59 UTC, i.e. early evening Eastern).
 * The team works in Eastern time, so show it there with the clock time — a
 * bare UTC date reads as "all day" and can be a day late.
 */
export function formatDeadline(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

/** Time left until the deadline, in hours under 2 days ("passed" once it's gone). */
export function timeLeftLabel(iso: string, nowMs: number): { label: string; hoursLeft: number } {
  const hoursLeft = (Date.parse(iso) - nowMs) / 36e5;
  if (hoursLeft <= 0) return { label: "passed", hoursLeft };
  if (hoursLeft < 48) return { label: `${Math.floor(hoursLeft)}h left`, hoursLeft };
  return { label: `${Math.floor(hoursLeft / 24)}d left`, hoursLeft };
}
