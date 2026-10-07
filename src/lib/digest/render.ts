/**
 * DigestData → Discord embed (plan v2 §2–§4). Pure. Owns the flags, the
 * "partial" / "could not run" verdicts, and Discord's hard limits (6,000
 * chars total, 25 fields, 1,024 per value, 4,096 description): lowest-priority
 * fields are dropped first until the embed fits.
 */

import type { DigestData, Flag, Metric, Baselined } from "./types";
import type { ReadResult } from "./read";

export const BRAND = 0xf87356;
export const RED = 0xdc2626;
export const DISCORD_TOTAL_LIMIT = 6_000;
const SAFE_TOTAL = 5_800;
const FIELD_VALUE_LIMIT = 1_024;
const DESCRIPTION_LIMIT = 4_096;
/** Flags beyond this are summarised as "… and N more" so a ResLab-wide sold-out day cannot silently lose flags to the description clamp. */
export const MAX_FLAGS = 20;

export interface Embed {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  footer: { text: string };
}

export type Verdict =
  | { kind: "ok" }
  | { kind: "partial"; failed: string[] }
  | { kind: "could_not_run"; failed: string[]; total: number };

const SECTION_NAMES = ["bookings", "whereFrom", "funnel", "lostSales", "engagement", "health"] as const;

export function verdictFor(d: DigestData): Verdict {
  const failed = SECTION_NAMES.filter((s) => !d[s].ok);
  if (failed.length === 0) return { kind: "ok" };
  if (!d.bookings.ok || failed.length * 2 >= SECTION_NAMES.length) {
    return { kind: "could_not_run", failed, total: SECTION_NAMES.length };
  }
  return { kind: "partial", failed };
}

// ── formatting ──

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const m = (v: Metric, f: (n: number) => string = String) => (v === "unavailable" ? "unavailable" : f(v));
const pct = (v: Metric) => m(v, (n) => `${Math.round(n * 100)}%`);
const clamp = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s); // declared before its first caller

// ── flags ──

export function flagsFor(d: DigestData, extra: Flag[] = []): Flag[] {
  const flags: Flag[] = [...extra];
  if (d.bookings.ok) {
    const b = d.bookings.data;
    if (b.count.baselineError) flags.push({ text: "bookings baselines unavailable (the day's numbers are real)" });
    if (b.repeatError) flags.push({ text: "repeat-customer lookup unavailable" });
    if (b.unpricedRows > 0) flags.push({ text: `${b.unpricedRows} booking(s) with a NULL money column — GMV / fee income withheld for the whole day` });
    else if (b.gmv === "unavailable" || b.feeIncome === "unavailable" || b.chargedOnline === "unavailable" || b.pgRefundedWholesaleEaten === "unavailable") flags.push({ text: "money totals unavailable — do not read yesterday's revenue from this digest" });
    if (b.count.value !== "unavailable" && b.count.avg7 !== null && b.count.avg7 >= 2 && b.count.value < b.count.avg7 * 0.5) {
      flags.push({ text: `bookings ${b.count.value} < half the 7-day avg (${b.count.avg7.toFixed(1)})` });
    }
    if (b.unmatched > 0) flags.push({ text: `${b.unmatched} booking(s) with no payment record — check manually` });
    if (b.otherStatus > 0) flags.push({ text: `${b.otherStatus} booking(s) with an unknown status` });
    if (b.dirtyPgRows > 0) flags.push({ text: `${b.dirtyPgRows} Park Guard row(s) with no wholesale recorded` });
    if (b.leadTime.unknown > 0) flags.push({ text: `${b.leadTime.unknown} booking(s) with no lot timezone (lead time unknown)` });
  }
  if (d.funnel.ok) {
    const f = d.funnel.data;
    const health = d.health.ok ? d.health.data : null;
    // Not gated on a baseline: telemetry starts 2026-09-24, so avg7 is null for the
    // digest's whole first week — exactly when a dead writer must still be flagged.
    if (f.originSearches.value === 0) {
      if (health && health.telemetry.kind === "ok") flags.push({ text: "zero origin searches (telemetry writer healthy)" });
      else flags.push({ text: "zero origin searches AND the search telemetry writer is silent or stale" });
    }
    // The customer-visible outcome is flagged on its own, whatever the cause: a day on
    // which nothing priced, or most priced searches showed no lot, must never read green.
    if (f.pricedSearches === 0 && f.originSearches.value !== "unavailable" && f.originSearches.value > 0) {
      // An observation, not a cause: sold_out_count is NULL both when ResLab priced nothing
      // AND when the location list came back empty (a thin snapshot, a blocked-id mistake).
      flags.push({ text: `no search priced a single lot (${f.originSearches.value} origin searches) — ResLab pricing or the location list, not inventory` });
    } else if (f.zeroResultShare !== "unavailable" && f.zeroResultShare > 0.3) {
      flags.push({ text: `${Math.round(f.zeroResultShare * 100)}% of priced searches showed the customer no lots at all` });
    }
    for (const a of f.nothingBookableByAirport) {
      if (a.priced >= 5 && a.share > 0.3) flags.push({ text: `${a.key}: ${Math.round(a.share * 100)}% of priced searches found nothing bookable (sold out, not degraded)` });
    }
  }
  if (d.lostSales.ok) {
    const failed = Object.entries(d.lostSales.data.byStatus).filter(([k, n]) => /failed/.test(k) && n > 0);
    for (const [k, n] of failed) flags.push({ text: `${n} lost sale(s): ${k}` });
  }
  if (d.health.ok) {
    const h = d.health.data;
    if (h.telemetry.kind === "silent_7d") flags.push({ text: "search telemetry writer silent ≥ 7 days" });
    if (h.telemetry.kind === "stale") flags.push({ text: `search telemetry writer STALE (last production row ${h.telemetry.lastRowAt.slice(0, 16).replace("T", " ")} UTC, ${h.telemetry.rows24h} rows/24h)` });
    if (h.telemetry.kind === "unavailable") flags.push({ text: "search telemetry health unreadable" });
    if (h.lastDigest.kind === "error") flags.push({ text: "digest run log unreadable — duplicate posts possible, 'last digest' unknown" });
    if (h.snapshot.kind === "missing") flags.push({ text: "ResLab snapshot missing — refresh cron has never succeeded" });
    // "behind" (> SNAPSHOT_WARN_MS) already costs search its long CDN TTL; a ⚠️ in a droppable Health line is not enough.
    if (h.snapshot.kind === "row" && (h.snapshot.stale || h.snapshot.behind)) flags.push({ text: `ResLab snapshot ${h.snapshot.stale ? "stale" : "behind"} (${h.snapshot.ageHours} h)` });
    if (h.stuckPending.kind === "n" && h.stuckPending.n > 0) flags.push({ text: `${h.stuckPending.n} pending booking(s) stuck > 1 h (possibly mid-sweep)` });
    if (h.stuckPending.kind === "error") flags.push({ text: "stuck-pending check unavailable (money could be stranded unseen)" });
  }
  return flags;
}

// ── layout ──
//
// Discord renders inline fields three to a row, so the numbers people scan for
// are six tiles (two rows), each "**big number**" over one short line of
// context. The written read sits at the top under the flags — it is the part
// worth reading first. Detail blocks use plain labels; every caveat that used
// to sit in the body lives in the footer.

const one = (n: number) => String(Math.round(n * 10) / 10);
const titleCase = (k: string) => (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, " ");
const weekday = (dateEt: string) => {
  const [y, mo, d] = dateEt.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
};
const kv = (o: Record<string, number>) => Object.entries(o).map(([k, n]) => `${titleCase(k)} ${n}`).join(" · ");
/** pending_bookings statuses in plain words — title-casing "released_failed" reads as the opposite of what it means. */
const STATUS_WORDS: Record<string, string> = {
  completed: "completed",
  pending: "pending",
  processing: "processing",
  released_failed: "hold released (ResLab rejected)",
  released_sold_out: "hold released (sold out)",
  refunded_failed: "refunded (ResLab rejected)",
  refunded_sold_out: "refunded (sold out)",
  expired: "expired",
  failed: "failed",
  suspected_duplicate: "duplicate (lost the cart race)",
  refunded_after_capture: "refunded (after capture)",
  needs_reconciliation: "NEEDS RECONCILIATION",
  capture_ambiguous: "CAPTURE AMBIGUOUS",
};
const statusWords = (k: string) => STATUS_WORDS[k] ?? k;
// Month/day from the window label so the title spells "Sept" the way the footer does.
const monthDay = (windowLabel: string) => windowLabel.split(" · ")[0].replace(/, \d{4}$/, "");

function baselineLine(b: Baselined, f: (n: number) => string = one): string {
  if (b.baselineError) return `baselines unavailable (${b.baselineError.slice(0, 50)})`;
  const a7 = b.avg7 === null ? `7-day avg n/a (data since ${b.since.slice(5)})` : `7-day avg ${f(b.avg7)}`;
  const a28 = b.avg28 === null ? "28-day n/a" : `28-day ${f(b.avg28)}`;
  return `${a7} · ${a28}`;
}

const NA = (why: string) => `**n/a**\n${clamp(why, 60)}`;

function tiles(d: DigestData): Embed["fields"] {
  // The compiler proves the reason is non-empty: a failed section always carries its error.
  const bookingsTile = d.bookings.ok ? `**${m(d.bookings.data.count.value)}**\n${baselineLine(d.bookings.data.count)}` : NA(d.bookings.error);
  const feeTile = d.bookings.ok
    ? `**${m(d.bookings.data.feeIncome, usd)}**\nservice ${m(d.bookings.data.serviceFees, usd)} · Park Guard ${m(d.bookings.data.pgMargin, usd)}`
    : NA(d.bookings.error);
  const gmvTile = d.bookings.ok
    ? (() => {
        const b = d.bookings.data;
        const online = b.chargedOnline !== "unavailable" && b.gmv !== "unavailable" && b.chargedOnline < b.gmv ? ` · online ≈ ${usd(b.chargedOnline)}` : "";
        return `**${m(b.gmv, usd)}**\navg order ${m(b.avgOrder, usd)}${online}`;
      })()
    : NA(d.bookings.error);
  const searchTile = d.funnel.ok
    ? `**${m(d.funnel.data.originSearches.value)}**\n${m(d.funnel.data.distinctAirports)} airports · CDN misses · ${baselineLine(d.funnel.data.originSearches, (n) => String(Math.round(n)))}`
    : NA(d.funnel.error);
  const noLotTile = d.funnel.ok
    ? d.funnel.data.pricedSearches === 0
      ? `**n/a**\nnothing priced all day`
      : `**${pct(d.funnel.data.zeroResultShare)}**\nof ${d.funnel.data.pricedSearches} priced · lots sold out ${pct(d.funnel.data.lotSoldOutRate)}`
    : NA(d.funnel.error);
  const pgTile = d.bookings.ok ? `**${pct(d.bookings.data.pgAttachRate)}**\nattach rate` : NA(d.bookings.error);
  return [
    { name: "Bookings", value: bookingsTile, inline: true },
    { name: "Fee income", value: feeTile, inline: true },
    { name: "GMV", value: gmvTile, inline: true },
    { name: "Searches (server-side)", value: searchTile, inline: true },
    { name: "No lot shown", value: noLotTile, inline: true },
    { name: "Park Guard", value: pgTile, inline: true },
  ];
}

function whereFromField(d: DigestData): string {
  if (!d.whereFrom.ok) return `unavailable (${d.whereFrom.error})`;
  const w = d.whereFrom.data;
  const land = w.landing;
  const landed = [
    land.blog ? `blog post ${land.blog}` : "",
    land.airportPage ? `airport page ${land.airportPage}` : "",
    land.homepage ? `homepage ${land.homepage}` : "",
    land.other ? `other ${land.other}` : "",
    land.none ? `no cookie ${land.none}` : "",
  ].filter(Boolean).join(" · ") || "—";
  const posts = w.topBlogPosts.map((p) => `${p.path.replace(/^\/blog\//, "")}${p.bookings > 1 ? ` (${p.bookings})` : ""}`).join(", ");
  return [
    `${w.byChannel.slice(0, 6).map((c) => `${titleCase(c.key)} ${c.bookings}`).join(" · ") || "—"}`,
    `Landed on: ${landed}${w.aiReferrals ? ` · AI-assistant referrals ${w.aiReferrals}` : ""}`,
    w.topAirports.length ? `Airports: ${w.topAirports.map((a) => `${a.key} ${a.bookings}`).join(", ")}` : "",
    posts ? `Top posts: ${posts}` : "",
  ].filter(Boolean).join("\n");
}

function leadTimeField(d: DigestData): string {
  if (!d.bookings.ok) return `unavailable (${d.bookings.error})`;
  const b = d.bookings.data;
  const lt = b.leadTime;
  const lines = [
    `Same-day ${lt.sameDay} · 1–3 days ${lt.d1to3} · 4–14 days ${lt.d4to14} · 15+ days ${lt.d15plus}${lt.unknown ? ` · unknown ${lt.unknown}` : ""}`,
    `Promo bookings ${b.promoBookings}${b.promoDiscount !== "unavailable" && b.promoDiscount > 0 ? ` (${usd(b.promoDiscount)} off)` : ""} · repeat customers ${m(b.repeatByEmail)}${b.repeatCapped ? " (cap)" : ""}`,
  ];
  const extras: string[] = [];
  if (b.refunded) extras.push(`refunded ${b.refunded}`);
  if (b.disputed) extras.push(`disputed ${b.disputed}`);
  if (b.cancelledOrFailed) extras.push(`cancelled/failed ${b.cancelledOrFailed}`);
  if (b.staging) extras.push(`staging (excluded) ${b.staging}`);
  if (b.unmatched) extras.push(`unmatched ${b.unmatched}`);
  if (b.otherStatus) extras.push(`other status ${b.otherStatus}`);
  if (b.pgRefundedWholesaleEaten !== "unavailable" && b.pgRefundedWholesaleEaten > 0) extras.push(`Park Guard wholesale eaten on refunds ${usd(b.pgRefundedWholesaleEaten)}`);
  if (extras.length) lines.push(extras.join(" · "));
  return lines.join("\n");
}

function lostSalesField(d: DigestData): string {
  if (!d.lostSales.ok) return `unavailable (${d.lostSales.error})`;
  const l = d.lostSales.data;
  const status = Object.entries(l.byStatus).map(([k, n]) => `${statusWords(k)} ${n}`).join(" · ") || "no checkouts";
  const rows = l.rows.slice(0, 6).map((r) => `• ${r.airport} · ${r.lot} · ${statusWords(r.status)} · ${r.reason}`);
  return [`Checkouts: ${status}`, ...(rows.length ? rows : ["No lost sales."])].join("\n");
}

function searchDetailField(d: DigestData): string {
  if (!d.funnel.ok) return `unavailable (${d.funnel.error})`;
  const f = d.funnel.data;
  const lines = [
    `Top airports: ${f.topAirports.map((a) => `${a.key} ${a.searches}`).join(", ") || "—"}`,
    `Dates defaulted ${pct(f.datesDefaultedShare)} · avg results per search ${m(f.meanResults, (n) => n.toFixed(1))} · degraded ${m(f.degradedCount)} (over-represented: degraded results re-originate)`,
  ];
  if (f.pricedSearches > 0 && (f.nothingBookableShare === "unavailable" || f.nothingBookableShare > 0 || f.nothingBookableDegraded > 0)) {
    lines.push(`Sold out and empty ${pct(f.nothingBookableShare)} of ${f.pricedSearches} priced${f.nothingBookableDegraded ? ` (+${f.nothingBookableDegraded} on degraded searches — ResLab, not inventory)` : ""}`);
  }
  return lines.join("\n");
}

function engagementField(d: DigestData): string {
  if (!d.engagement.ok) return `unavailable (${d.engagement.error})`;
  const e = d.engagement.data;
  const nl = Object.values(e.newsletterBySource).reduce((n, v) => n + v, 0);
  const wl = Object.values(e.waitlistByAirport).reduce((n, v) => n + v, 0);
  return `Newsletter ${nl}${nl ? ` (${kv(e.newsletterBySource)})` : ""} · Waitlist ${wl}${wl ? ` (${kv(e.waitlistByAirport)})` : ""} · Chat sessions ${m(e.chatSessions)} · WELCOME codes ${m(e.welcomeCodesMinted)}`;
}

function healthField(d: DigestData): string {
  if (!d.health.ok) return `⚠️ unavailable (${d.health.error})`;
  const h = d.health.data;
  const t = h.telemetry;
  // warn = something is wrong; neutral = nothing wrong but nothing to vouch for either
  // (the snapshot flag off, no earlier digest on record). Only an all-clear line gets ✅.
  type Part = { text: string; warn?: boolean; neutral?: boolean };
  const parts: Part[] = [];
  parts.push(
    t.kind === "silent_7d"
      ? { text: "search telemetry SILENT ≥ 7 days", warn: true }
      : t.kind === "unavailable"
        ? { text: `search telemetry unreadable (${clamp(t.error, 50)})`, warn: true }
        : t.kind === "ok"
          ? { text: `telemetry ok (${t.rows24h} rows/24h)` }
          : { text: `telemetry STALE (last production row ${t.lastRowAt.slice(0, 16).replace("T", " ")} UTC, ${t.rows24h} rows/24h)`, warn: true }
  );
  parts.push(
    h.snapshot.kind === "off"
      ? { text: "snapshot off", neutral: true }
      : h.snapshot.kind === "row"
        ? { text: `snapshot${h.snapshot.stale ? " STALE" : h.snapshot.behind ? " behind" : ""} ${h.snapshot.ageHours} h, ${h.snapshot.locationCount} lots`, warn: h.snapshot.stale || h.snapshot.behind }
        : h.snapshot.kind === "missing"
          ? { text: "snapshot MISSING", warn: true }
          : { text: `snapshot unreadable (${clamp(h.snapshot.message, 50)})`, warn: true }
  );
  parts.push(
    h.stuckPending.kind === "n"
      ? { text: `stuck pending ${h.stuckPending.n}`, warn: h.stuckPending.n > 0 }
      : { text: `stuck pending UNKNOWN (${clamp(h.stuckPending.message, 50)})`, warn: true }
  );
  if (h.lastDigest.kind === "none") parts.push({ text: "no earlier digest on record", neutral: true });
  else if (h.lastDigest.kind === "days" && h.lastDigest.n !== 1) parts.push({ text: `last digest ${h.lastDigest.n} days ago`, warn: true });
  else if (h.lastDigest.kind === "error") parts.push({ text: `last digest UNKNOWN (run log: ${clamp(h.lastDigest.message, 50)})`, warn: true });
  const line = parts.map((p) => (p.warn ? `⚠️ ${p.text}` : p.text)).join(" · ");
  return parts.some((p) => p.warn || p.neutral) ? line : `✅ ${line}`;
}

// ── assembly ──

function counted(e: Embed): number {
  return e.title.length + e.description.length + e.footer.text.length + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
}

export function renderEmbed(d: DigestData, read: ReadResult | null, extraFlags: Flag[] = []): { embed: Embed; verdict: Verdict; flags: Flag[]; truncated: boolean } {
  const verdict = verdictFor(d);
  const day = `${weekday(d.dateEt)} ${monthDay(d.windowLabel)}`;
  const footerBase = `${d.windowLabel} · GMV includes due-at-lot and is pre-discount · fee income = service fees + Park Guard margin, before ResLab's fee and before promo · searches are server-side (CDN misses), not customers · engagement counts include staging · not GA4 / Stripe payouts · generated ${d.generatedAt.slice(11, 16)} UTC`;

  if (verdict.kind === "could_not_run") {
    // Route-level flags (e.g. "run log unreadable — may be a duplicate") must survive here too.
    const extraLines = extraFlags.length ? `\n${extraFlags.map((f) => `• ${f.text}`).join("\n")}` : "";
    return {
      embed: {
        title: `🛑 Triply daily — ${d.dateEt} — DIGEST COULD NOT RUN`,
        description: clamp(`${verdict.failed.length} of ${verdict.total} sections failed (${verdict.failed.join(", ")}). No numbers are shown so none can be misread.${extraLines}`, DESCRIPTION_LIMIT),
        color: RED,
        fields: [],
        footer: { text: d.windowLabel },
      },
      verdict,
      flags: extraFlags,
      truncated: false,
    };
  }

  const flags = flagsFor(d, extraFlags);
  const title = verdict.kind === "partial" ? `⚠️ Triply daily — ${day} — partial` : `📊 Triply daily — ${day}`;
  let truncated = false;
  const shownFlags = flags.slice(0, MAX_FLAGS).map((f) => `• ${f.text}`);
  if (flags.length > MAX_FLAGS) {
    shownFlags.push(`… and ${flags.length - MAX_FLAGS} more flag(s)`);
    truncated = true;
  }
  const readLine =
    read === null ? "" : read.kind === "ok" ? `_Read (Haiku, from the aggregates):_ ${read.text}` : read.kind === "withheld" ? `_Read withheld (${read.reason})._` : `_Read unavailable (${read.reason})._`;
  const flagBlock = flags.length ? `🔴 **Flags**\n${shownFlags.join("\n")}` : "✅ No flags.";
  const fullDescription = [flagBlock, readLine].filter(Boolean).join("\n\n");
  const description = clamp(fullDescription, DESCRIPTION_LIMIT);
  if (description !== fullDescription) truncated = true;

  // Visual order, with a drop priority (lower drops first) that is independent of it.
  type Ranked = { field: Embed["fields"][number]; keep: number };
  const tileRows = tiles(d);
  const FLOOR = tileRows.length; // the tiles are never dropped
  const ranked: Ranked[] = [
    ...tileRows.map((field) => ({ field, keep: 9 })),
    { field: { name: "Where bookings came from", value: clamp(whereFromField(d), FIELD_VALUE_LIMIT) }, keep: 6 },
    { field: { name: "Lead time & extras", value: clamp(leadTimeField(d), FIELD_VALUE_LIMIT) }, keep: 5 },
    { field: { name: "Lost sales", value: clamp(lostSalesField(d), FIELD_VALUE_LIMIT) }, keep: 7 },
    { field: { name: "Search detail", value: clamp(searchDetailField(d), FIELD_VALUE_LIMIT) }, keep: 3 },
    { field: { name: "Engagement", value: clamp(engagementField(d), FIELD_VALUE_LIMIT) }, keep: 2 },
    { field: { name: "Health", value: clamp(healthField(d), FIELD_VALUE_LIMIT) }, keep: 8 },
  ];

  const build = (rows: Ranked[]): Embed => ({
    title: clamp(title, 256),
    description,
    color: flags.length || verdict.kind === "partial" ? RED : BRAND,
    fields: rows.map((r) => r.field),
    footer: { text: clamp(footerBase, 2_048) },
  });
  let rows = ranked;
  let embed = build(rows);
  while (counted(embed) > SAFE_TOTAL && rows.length > FLOOR) {
    const lowest = Math.min(...rows.map((r) => r.keep));
    rows = rows.filter((r) => r.keep !== lowest);
    embed = build(rows);
    truncated = true;
  }
  if (truncated) embed.footer.text = clamp(`… truncated to fit Discord · ${footerBase}`, 2_048);
  if (counted(embed) > DISCORD_TOTAL_LIMIT) {
    embed.description = clamp(embed.description, Math.max(50, DISCORD_TOTAL_LIMIT - (counted(embed) - embed.description.length) - 10));
    truncated = true;
    embed.footer.text = clamp(`… truncated to fit Discord · ${footerBase}`, 2_048);
  }
  return { embed, verdict, flags, truncated };
}
