import { DISCORD_TOTAL_LIMIT, RED, type Embed } from "@/lib/digest/render";
import { ALERT_KINDS, type AlertItem, type AlertKind } from "./scan";

/**
 * The Discord message(s) for one alerts tick (6b plan §5, E3): normally ONE
 * post; split only when the lines exceed Discord's limits (6,000 characters
 * per message, 1,024 per field, 25 fields). Lines are already ordered URGENT
 * first. Each post remembers its items so `alerted_at` is set only for what
 * Discord accepted.
 *
 * Test mode (`livemode = false`, staging): every title and line is prefixed
 * "[TEST]" and nothing pings. Live with an URGENT item: `content: "@here"` with
 * `allowed_mentions: everyone` — a mention inside an embed never pings. Lines
 * carry TRP numbers and lot ids only (no customer details).
 */

export const ALERTS_USERNAME = "Triply Alerts";
const AMBER = 0xf59e0b;
const FIELD_LIMIT = 1_024;
const MAX_FIELDS = 25;
const LINE_LIMIT = 400;
/** Room kept for title, description and footer (each built well under it). */
const HEADER_RESERVE = 900;
const BODY_LIMIT = DISCORD_TOTAL_LIMIT - HEADER_RESERVE;

/** Kinds are listed in ALERT_KINDS order within an urgency tier. */
export const KIND_LABEL: Record<AlertKind, string> = {
  lot_notice: "Lot notice not confirmed — it may not have arrived",
  cancel_notice: "Lot not told of a cancellation",
  manifest: "Evening manifest",
  followup: "Manifest follow-up",
  lot_config: "Lot setup",
};

export interface AlertMessage {
  embed: Embed;
  content?: string;
  allowedMentions?: { parse: Array<"everyone"> };
  items: AlertItem[];
}

export function alertLine(item: AlertItem, livemode: boolean): string {
  const line = `${livemode ? "" : "[TEST] "}${item.urgent ? "🚨 URGENT " : ""}${item.text}`;
  return line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT - 1)}…` : line;
}

interface Draft {
  fields: Array<{ name: string; value: string }>;
  items: AlertItem[];
  chars: number;
}

/**
 * @param due     the items to post, URGENT first
 * @param overflow per kind: items found beyond the per-scan cap (not shown)
 */
export function buildAlertMessages(due: AlertItem[], o: { livemode: boolean; overflow: Partial<Record<AlertKind, number>> }): AlertMessage[] {
  if (due.length === 0) return [];
  const prefix = o.livemode ? "" : "[TEST] ";
  const drafts: Draft[] = [];
  let cur: Draft = { fields: [], items: [], chars: 0 };

  for (const item of due) {
    const line = alertLine(item, o.livemode);
    const label = KIND_LABEL[item.kind];
    const last = cur.fields[cur.fields.length - 1];
    const sameKind = !!last && last.name.startsWith(label);
    if (sameKind && last.value.length + 1 + line.length <= FIELD_LIMIT && cur.chars + 1 + line.length <= BODY_LIMIT) {
      last.value += `\n${line}`;
      cur.chars += 1 + line.length;
      cur.items.push(item);
      continue;
    }
    let name = sameKind ? `${label} (cont.)` : label;
    if (cur.fields.length >= MAX_FIELDS || cur.chars + name.length + line.length > BODY_LIMIT) {
      drafts.push(cur);
      cur = { fields: [], items: [], chars: 0 };
      name = label;
    }
    cur.fields.push({ name, value: line });
    cur.chars += name.length + line.length;
    cur.items.push(item);
  }
  drafts.push(cur);

  const overflow = ALERT_KINDS.filter((k) => (o.overflow[k] ?? 0) > 0).map((k) => `${KIND_LABEL[k]} +${o.overflow[k]}`);
  const total = due.length;
  const urgentTotal = due.filter((i) => i.urgent).length;

  return drafts.map((d, i) => {
    const urgent = d.items.filter((it) => it.urgent).length;
    const part = drafts.length > 1 ? ` — part ${i + 1}/${drafts.length}` : "";
    const title = `${prefix}${urgentTotal > 0 ? "🚨" : "⚠️"} Direct lots — ${total} alert${total === 1 ? "" : "s"}${urgentTotal > 0 ? ` (${urgentTotal} URGENT)` : ""}${part}`;
    const description =
      `${prefix}Open problems with direct-lot bookings — TRP numbers and lot ids only (no customer details); look them up in /admin/bookings. ` +
      `URGENT items repeat hourly, the rest every 6 h, until fixed.` +
      (i === 0 && overflow.length > 0 ? ` Not shown this time: ${overflow.join(", ")}.` : "");
    const embed: Embed = {
      title,
      description,
      color: urgent > 0 ? RED : AMBER,
      fields: d.fields,
      footer: { text: `${prefix}${ALERTS_USERNAME} · ${o.livemode ? "production (live Stripe)" : "test mode (staging)"}` },
    };
    const msg: AlertMessage = { embed, items: d.items };
    if (o.livemode && urgent > 0) {
      msg.content = "@here";
      msg.allowedMentions = { parse: ["everyone"] };
    }
    return msg;
  });
}
