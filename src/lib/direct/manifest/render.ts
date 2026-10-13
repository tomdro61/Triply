import { escapeHtml } from "@/lib/validation/schemas";
import { convertTo12Hour, minutesTo12Hour } from "@/lib/utils/time";
import { formatDate } from "@/lib/utils";
import type { ManifestRow } from "./select";

/**
 * The manifest email (6b plan §3.3, Q7) and the follow-up cancel reminder.
 * Pure: everything it shows is passed in. Every value from a booking is
 * escaped; times are the literal wall-clock strings, never re-zoned.
 *
 * The manifest is a REMINDER of bookings the lot was already emailed. It never
 * says "no arrivals": an empty-day email says only that nothing is in it.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface ManifestEmailInput {
  lotName: string;
  /** "YYYY-MM-DD", lot-local. */
  manifestDate: string;
  /** Listed rows (already re-checked). Empty = the empty-day reminder. */
  rows: ManifestRow[];
  /** Lot-local minutes since midnight when the list was read. */
  asOfMinutes: number;
  test: boolean;
}

export const MANIFEST_HEADER = "A reminder of the bookings we have already emailed you.";
export const MANIFEST_EMPTY_LINE = "Nothing in this reminder — new bookings come as separate emails.";
export const manifestFooter = (asOfMinutes: number) =>
  `As of ${minutesTo12Hour(asOfMinutes)} lot time. New bookings and every cancellation still come as separate emails — a cancellation email always overrides this list.`;

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const timeOf = (wallClock: string) => convertTo12Hour(wallClock.slice(11, 16));
const dateOf = (wallClock: string) => wallClock.slice(0, 10);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function vehicleLine(v: ManifestRow["vehicle"]): string {
  const car = [v.color, v.make, v.model].filter(Boolean).join(" ") || "Vehicle not given";
  const plate = v.licensePlate ? ` — plate ${v.licensePlate}${v.state ? ` (${v.state})` : ""}` : "";
  return `${car}${plate}`;
}

function atLotLine(cents: number | null): string {
  if (cents === null) return "Unknown — see the booking email";
  return cents > 0 ? `${usd(cents)} (oversized-vehicle surcharge incl. tax)` : "Nothing";
}

const COLUMNS = ["Time", "Confirmation", "Guest", "Phone", "Vehicle", "Size", "Collect at the lot (est.)", "Park Guard"] as const;

function cells(r: ManifestRow, wallClock: string): string[] {
  return [timeOf(wallClock), r.number, r.guestName, r.guestPhone, vehicleLine(r.vehicle), r.sizeLabel, atLotLine(r.atLotCents), r.parkGuard ? "Yes" : "No"];
}

function section(title: string, rows: Array<{ row: ManifestRow; at: string }>): { html: string; text: string } {
  if (rows.length === 0) return { html: "", text: "" };
  const th = COLUMNS.map((c) => `<th style="text-align:left;padding:6px 8px;color:#64748b;border-bottom:2px solid #e5e7eb;white-space:nowrap;">${escapeHtml(c)}</th>`).join("");
  const body = rows
    .map(
      ({ row, at }) =>
        `<tr>${cells(row, at)
          .map((c) => `<td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${escapeHtml(c)}</td>`)
          .join("")}</tr>`
    )
    .join("");
  const html = `
      <h3 style="margin:20px 0 8px;">${escapeHtml(title)}</h3>
      <table style="border-collapse:collapse;width:100%;font-size:14px;"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
  const text = [`${title}`, ...rows.map(({ row, at }) => `- ${cells(row, at).map((c, i) => `${COLUMNS[i]}: ${c}`).join(" | ")}`)].join("\n");
  return { html, text };
}

export function renderManifest(input: ManifestEmailInput): RenderedEmail {
  const { lotName, manifestDate, rows, asOfMinutes, test } = input;
  const arrivals = rows
    .filter((r) => dateOf(r.checkIn) === manifestDate)
    .map((row) => ({ row, at: row.checkIn }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.row.number.localeCompare(b.row.number));
  const departures = rows
    .filter((r) => dateOf(r.checkOut) === manifestDate)
    .map((row) => ({ row, at: row.checkOut }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.row.number.localeCompare(b.row.number));
  const day = formatDate(manifestDate);
  const prefix = test ? "[TEST] " : "";
  const empty = arrivals.length === 0 && departures.length === 0;
  const subject = empty
    ? `${prefix}Reminder — Triply, ${day} at ${lotName}: nothing in this reminder`
    : `${prefix}Reminder — Triply bookings for ${day} at ${lotName} (${plural(arrivals.length, "arrival", "arrivals")}, ${plural(departures.length, "departure", "departures")})`;
  const footer = manifestFooter(asOfMinutes);
  const a = section(`Arrivals — ${day}`, arrivals);
  const d = section(`Departures — ${day}`, departures);
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 760px;">
      ${test ? `<p style="background:#fef3c7;padding:8px 12px;border-radius:6px;color:#92400e;"><strong>TEST</strong> — not real customers. Sent to the override inbox, not the lot.</p>` : ""}
      <h2 style="margin:0 0 8px;">Tomorrow at ${escapeHtml(lotName)} — ${escapeHtml(day)}</h2>
      <p style="margin:0 0 12px;">${escapeHtml(MANIFEST_HEADER)}</p>
      ${empty ? `<p style="margin:12px 0;font-weight:600;">${escapeHtml(MANIFEST_EMPTY_LINE)}</p>` : `${a.html}${d.html}`}
      <p style="color:#64748b;font-size:12px;margin-top:16px;">${escapeHtml(footer)}</p>
    </div>`;
  const text = [
    `${prefix}Tomorrow at ${lotName} — ${day}`,
    "",
    MANIFEST_HEADER,
    "",
    empty ? MANIFEST_EMPTY_LINE : [a.text, d.text].filter(Boolean).join("\n\n"),
    "",
    footer,
  ].join("\n");
  return { subject, html, text };
}

export interface FollowUpCancelContent {
  number: string;
  lotName: string;
  customerName: string;
  /** Literal lot-local "YYYY-MM-DD HH:MM:SS". */
  fromDate: string;
  toDate: string;
  vehicleLine: string;
}

const fmtWhen = (wallClock: string) => {
  const [date, time] = wallClock.split(" ");
  return `${formatDate(date)} at ${convertTo12Hour(time)}`;
};

/**
 * The follow-up cancel reminder sent after a manifest that listed a booking
 * since cancelled. Same wording and fields as the 4b-2 cancel notice
 * (lot-notice.ts `cancelNoticeEmail`, which is private there): a cancellation
 * must read the same however it reaches the lot.
 */
export function renderFollowUpCancel(c: FollowUpCancelContent, test: boolean): RenderedEmail {
  const rows: Array<[string, string]> = [
    ["Confirmation", c.number],
    ["Customer", c.customerName],
    ["Was due", `${fmtWhen(c.fromDate)} → ${fmtWhen(c.toDate)}`],
    ["Vehicle", c.vehicleLine],
  ];
  const subject = `${test ? "[TEST] " : ""}CANCELLED — Triply booking ${c.number}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px;">
      ${test ? `<p style="background:#fef3c7;padding:8px 12px;border-radius:6px;color:#92400e;"><strong>TEST booking</strong> — not a real customer.</p>` : ""}
      <h2 style="margin:0 0 12px;">Booking cancelled at ${escapeHtml(c.lotName)}</h2>
      <p>Please do not expect this customer. The reservation below is no longer valid.</p>
      <table style="border-collapse:collapse;width:100%;">
        ${rows
          .map(
            ([k, val]) =>
              `<tr><td style="padding:6px 8px;color:#64748b;border-bottom:1px solid #e5e7eb;">${escapeHtml(k)}</td><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-weight:600;">${escapeHtml(val)}</td></tr>`
          )
          .join("")}
      </table>
    </div>`;
  return { subject, html, text: `${subject}\n\n${rows.map(([k, val]) => `${k}: ${val}`).join("\n")}` };
}
