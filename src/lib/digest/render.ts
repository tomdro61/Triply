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

function vsBaseline(b: Baselined, f: (n: number) => string = String): string {
  if (b.value === "unavailable") return "unavailable";
  const parts = [f(b.value)];
  if (b.baselineError) {
    parts.push(`baselines unavailable (${b.baselineError.slice(0, 60)})`);
    return parts.join(" · ");
  }
  parts.push(b.avg7 === null ? `7d n/a (data since ${b.since})` : `7d avg ${f(Math.round(b.avg7 * 10) / 10)}`);
  parts.push(b.avg28 === null ? "28d n/a" : `28d avg ${f(Math.round(b.avg28 * 10) / 10)}`);
  return parts.join(" · ");
}

const topList = (rows: Array<{ key: string; [k: string]: unknown }>, valueKey: string, n = 5) =>
  rows.slice(0, n).map((r) => `${r.key} ${String(r[valueKey])}`).join(", ") || "—";

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
    if (h.snapshot.kind === "row" && h.snapshot.stale) flags.push({ text: `ResLab snapshot stale (${h.snapshot.ageHours} h)` });
    if (h.stuckPending.kind === "n" && h.stuckPending.n > 0) flags.push({ text: `${h.stuckPending.n} pending booking(s) stuck > 1 h (possibly mid-sweep)` });
    if (h.stuckPending.kind === "error") flags.push({ text: "stuck-pending check unavailable (money could be stranded unseen)" });
  }
  return flags;
}

// ── sections → fields ──

function bookingsField(d: DigestData): string {
  if (!d.bookings.ok) return `unavailable (${d.bookings.error})`;
  const b = d.bookings.data;
  const lines = [
    `**${vsBaseline(b.count)}**`,
    `GMV ${m(b.gmv, usd)} (incl. due-at-lot, pre-discount) · charged online ≈ ${m(b.chargedOnline, usd)} · avg ${m(b.avgOrder, usd)}`,
    `Triply fee income ${m(b.feeIncome, usd)} (service ${m(b.serviceFees, usd)} + PG margin ${m(b.pgMargin, usd)})`,
    `PG attach ${pct(b.pgAttachRate)} · promo ${b.promoBookings} (${m(b.promoDiscount, usd)} off) · repeat (by email) ${m(b.repeatByEmail)}${b.repeatCapped ? " (cap)" : ""}`,
    `lead: same-day ${b.leadTime.sameDay} · 1–3d ${b.leadTime.d1to3} · 4–14d ${b.leadTime.d4to14} · 15d+ ${b.leadTime.d15plus}${b.leadTime.unknown ? ` · unknown ${b.leadTime.unknown}` : ""}`,
  ];
  const extras: string[] = [];
  if (b.refunded) extras.push(`refunded ${b.refunded}`);
  if (b.disputed) extras.push(`disputed ${b.disputed}`);
  if (b.cancelledOrFailed) extras.push(`cancelled/failed ${b.cancelledOrFailed}`);
  if (b.staging) extras.push(`staging (excluded) ${b.staging}`);
  if (b.unmatched) extras.push(`unmatched ${b.unmatched}`);
  if (b.otherStatus) extras.push(`other status ${b.otherStatus}`);
  if (b.pgRefundedWholesaleEaten !== "unavailable" && b.pgRefundedWholesaleEaten > 0) extras.push(`PG wholesale eaten on refunds ${usd(b.pgRefundedWholesaleEaten)}`);
  if (extras.length) lines.push(extras.join(" · "));
  return lines.join("\n");
}

function whereFromField(d: DigestData): string {
  if (!d.whereFrom.ok) return `unavailable (${d.whereFrom.error})`;
  const w = d.whereFrom.data;
  const land = w.landing;
  return [
    `channels: ${topList(w.byChannel, "bookings", 6)}`,
    `airports: ${topList(w.topAirports, "bookings", 5)}`,
    `landed on: blog ${land.blog} · airport page ${land.airportPage} · home ${land.homepage} · other ${land.other} · no cookie ${land.none}`,
    `AI-assistant referrals: ${w.aiReferrals}`,
    w.topBlogPosts.length ? `top posts: ${w.topBlogPosts.map((p) => `${p.path} (${p.bookings})`).join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

function funnelField(d: DigestData): string {
  if (!d.funnel.ok) return `unavailable (${d.funnel.error})`;
  const f = d.funnel.data;
  return [
    `origin searches (CDN misses, not customers): ${vsBaseline(f.originSearches)}`,
    `airports ${m(f.distinctAirports)} · top: ${topList(f.topAirports, "searches", 5)}`,
    `dates defaulted ${pct(f.datesDefaultedShare)} · mean results ${m(f.meanResults, (n) => n.toFixed(1))}`,
    // Both shares are over the SAME base (priced searches); say so rather than "of which".
    f.pricedSearches === 0
      ? "showed no lot: n/a — nothing priced all day"
      : `showed no lot ${pct(f.zeroResultShare)} of ${f.pricedSearches} priced searches · sold out and empty ${pct(f.nothingBookableShare)} of the same ${f.pricedSearches}${f.nothingBookableDegraded ? ` (+${f.nothingBookableDegraded} on degraded searches — ResLab, not inventory)` : ""} · lots sold out ${pct(f.lotSoldOutRate)}`,
    `degraded origin searches: ${m(f.degradedCount)} (over-represented — degraded results re-originate every request)`,
  ].join("\n");
}

function lostSalesField(d: DigestData): string {
  if (!d.lostSales.ok) return `unavailable (${d.lostSales.error})`;
  const l = d.lostSales.data;
  const status = Object.entries(l.byStatus).map(([k, n]) => `${k} ${n}`).join(" · ") || "none";
  const rows = l.rows.slice(0, 6).map((r) => `• ${r.airport} · ${r.lot} · ${r.status} · ${r.reason}`);
  return [status, ...rows].join("\n");
}

function engagementField(d: DigestData): string {
  if (!d.engagement.ok) return `unavailable (${d.engagement.error})`;
  const e = d.engagement.data;
  const kv = (o: Record<string, number>) => Object.entries(o).map(([k, n]) => `${k} ${n}`).join(", ") || "0";
  return [
    `newsletter: ${kv(e.newsletterBySource)} · waitlist: ${kv(e.waitlistByAirport)}`,
    `chat sessions ${m(e.chatSessions)} · WELCOME codes minted ${m(e.welcomeCodesMinted)}`,
  ].join("\n");
}

function healthField(d: DigestData): string {
  if (!d.health.ok) return `unavailable (${d.health.error})`;
  const h = d.health.data;
const t = h.telemetry;
  const tel =
    t.kind === "silent_7d"
      ? "search telemetry writer SILENT ≥ 7 days"
      : t.kind === "unavailable"
        ? `search telemetry unavailable (${t.error})`
        : `search telemetry ${t.kind === "ok" ? "ok" : "STALE"} (last production row ${t.lastRowAt.slice(0, 16).replace("T", " ")} UTC, ${t.rows24h} rows/24h)`;
  const snap =
    h.snapshot.kind === "off"
      ? "ResLab snapshot: flag off"
      : h.snapshot.kind === "row"
        ? `ResLab snapshot ${h.snapshot.ageHours} h old · ${h.snapshot.locationCount} lots${h.snapshot.stale ? " · STALE" : h.snapshot.behind ? " · behind" : ""}`
        : h.snapshot.kind === "missing"
          ? "ResLab snapshot MISSING"
          : `ResLab snapshot unreadable (${h.snapshot.message})`;
  const stuck = h.stuckPending.kind === "n" ? `stuck pending ${h.stuckPending.n}` : `stuck pending UNKNOWN (${h.stuckPending.message.slice(0, 60)})`;
  const last =
    h.lastDigest.kind === "none" ? "no earlier digest on record" : h.lastDigest.kind === "days" ? `last digest ${h.lastDigest.n} day(s) ago` : `last digest UNKNOWN (run log: ${h.lastDigest.message.slice(0, 60)})`;
  return [tel, snap, `${stuck} · ${last}`].join("\n");
}

// ── assembly ──

const clamp = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function counted(e: Embed): number {
  return e.title.length + e.description.length + e.footer.text.length + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
}

export function renderEmbed(d: DigestData, read: ReadResult | null, extraFlags: Flag[] = []): { embed: Embed; verdict: Verdict; flags: Flag[]; truncated: boolean } {
  const verdict = verdictFor(d);
  const footerBase = `${d.windowLabel} · generated ${d.generatedAt.slice(0, 16).replace("T", " ")} UTC · fee income excludes ResLab commission/fee and promo · not GA4/Sentry/Stripe payouts`;

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
  const title = `${verdict.kind === "partial" ? "⚠️ partial · " : ""}📊 Triply daily — ${d.windowLabel.split(" · ")[0]}`;
  let truncated = false;
  const shownFlags = flags.slice(0, MAX_FLAGS).map((f) => `• ${f.text}`);
  if (flags.length > MAX_FLAGS) {
    shownFlags.push(`… and ${flags.length - MAX_FLAGS} more flag(s)`);
    truncated = true;
  }
  const fullDescription = flags.length ? `🔴 **Flags**\n${shownFlags.join("\n")}` : "No flags.";
  const description = clamp(fullDescription, DESCRIPTION_LIMIT);
  if (description !== fullDescription) truncated = true;
  const readLine =
    read === null ? null : read.kind === "ok" ? read.text : read.kind === "withheld" ? `Model read withheld (${read.reason})` : `Model read unavailable (${read.reason})`;

  // Priority order = drop order reversed: the last entries are dropped first.
  const fields: Embed["fields"] = [
    { name: "Bookings", value: clamp(bookingsField(d), FIELD_VALUE_LIMIT) },
    { name: "Lost sales", value: clamp(lostSalesField(d), FIELD_VALUE_LIMIT) },
    { name: "Health", value: clamp(healthField(d), FIELD_VALUE_LIMIT) },
    ...(readLine ? [{ name: "Model read (from aggregates)", value: clamp(readLine, FIELD_VALUE_LIMIT) }] : []),
    { name: "Where from", value: clamp(whereFromField(d), FIELD_VALUE_LIMIT) },
    { name: "Funnel", value: clamp(funnelField(d), FIELD_VALUE_LIMIT) },
    { name: "Engagement (incl. staging)", value: clamp(engagementField(d), FIELD_VALUE_LIMIT) },
  ];

  const embed: Embed = {
    title: clamp(title, 256),
    description,
    color: flags.length || verdict.kind === "partial" ? RED : BRAND,
    fields,
    footer: { text: clamp(footerBase, 2_048) },
  };
  while (counted(embed) > SAFE_TOTAL && embed.fields.length > 1) {
    embed.fields.pop();
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
