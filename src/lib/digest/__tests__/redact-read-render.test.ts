import { describe, it, expect } from "vitest";
import { redactForDigest } from "../redact";
import { allowedTokens, firstUnexplainedNumber, modelInput } from "../read";
import { renderEmbed, verdictFor, flagsFor, DISCORD_TOTAL_LIMIT } from "../render";
import type { DigestData, BookingsSection, FunnelSection, HealthSection } from "../types";

describe("redactForDigest", () => {
  it("strips emails, phones, Stripe ids and plate-shaped tokens; keeps ResLab numbers and field names", () => {
    const s = 'HTTP 422: Validation error for ada.lovelace@example.com, phone (615) 391-2669, plate ABC1234, pi_3UJgnrG8zwENRSya1Re4ThBW, RTL854206 [fields: license_plate_number, vehicle_make]';
    const r = redactForDigest(s);
    expect(r).not.toMatch(/example\.com|615|ABC1234|pi_3UJ/);
    expect(r).toContain("[email]");
    expect(r).toContain("[phone]");
    expect(r).toContain("[plate]");
    expect(r).toContain("[stripe-id]");
    expect(r).toContain("RTL854206");
    expect(r).toContain("[fields: license_plate_number, vehicle_make]");
  });
  it("is a no-op on empty input", () => {
    expect(redactForDigest(null)).toBe("");
  });
  it("keeps a Triply direct-lot number (TRP-XXXXXXXX) whole, alongside RTL numbers, while still masking plates, emails and phones", () => {
    const s = "capture failed for TRP-7K2M9QXA (lot notice pending), RTL854206, plate ABC1234, ada@example.com, 615-391-2669";
    const r = redactForDigest(s);
    expect(r).toContain("TRP-7K2M9QXA");
    expect(r).not.toContain("TRP-[plate]");
    expect(r).toContain("RTL854206");
    expect(r).toContain("plate [plate]");
    expect(r).not.toMatch(/ABC1234|example\.com|391-2669/);
    expect(r).toContain("[email]");
    expect(r).toContain("[phone]");
  });
  it("an all-digit TRP tail is kept too (the phone pass needs 10 digits)", () => {
    expect(redactForDigest("TRP-23456789 ok")).toBe("TRP-23456789 ok");
  });
  it("does NOT exempt a plate merely because it follows 'TRP-': the whole token must be a valid Triply number", () => {
    // I/L/O/U are not Crockford; 7 chars is too short; a prefix glued to TRP- is not the number
    expect(redactForDigest("TRP-ABC1234L")).toBe("TRP-[plate]");
    expect(redactForDigest("TRP-ABC1234")).toBe("TRP-[plate]");
    expect(redactForDigest("XTRP-7K2M9QXA")).toBe("XTRP-[plate]");
    expect(redactForDigest("trp-7K2M9QXA")).toBe("trp-[plate]");
  });
});

const NO_UNSENT: HealthSection["emailNotSent"] = { kind: "n", n: 0, capped: false, numbers: [], lookbackDays: 7 };

function bookings(over: Partial<BookingsSection> = {}): BookingsSection {
  return {
    count: { value: 6, avg7: 5.2, avg28: 3.1, since: "2026-02-19" },
    staging: 0, unmatched: 0, otherStatus: 0, refunded: 0, disputed: 0, cancelledOrFailed: 0,
    gmv: 604, chargedOnline: 590, avgOrder: 100.67, feeIncome: 48.5, serviceFees: 35.7, pgMargin: 12.8,
    pgRefundedWholesaleEaten: 0, pgAttachRate: 0.33, dirtyPgRows: 0, promoBookings: 1, promoDiscount: 8.8,
    repeatByEmail: 1, repeatCapped: false, unpricedRows: 0,
    leadTime: { sameDay: 2, d1to3: 2, d4to14: 1, d15plus: 1, unknown: 0 },
    ...over,
  };
}
function funnel(over: Partial<FunnelSection> = {}): FunnelSection {
  return {
    originSearches: { value: 420, avg7: 400, avg28: null, since: "2026-09-24" },
    distinctAirports: 31,
    topAirports: [{ key: "JFK", searches: 40 }],
    datesDefaultedShare: 0.12, meanResults: 9.4, nothingBookableShare: 0.05, nothingBookableDegraded: 0, zeroResultShare: 0.06, pricedSearches: 300,
    nothingBookableByAirport: [], lotSoldOutRate: 0.2, degradedCount: 3,
    ...over,
  };
}
function data(over: Partial<DigestData> = {}): DigestData {
  return {
    dateEt: "2026-09-27",
    windowLabel: "Sept 27, 2026 · 00:00–24:00 ET",
    generatedAt: "2026-09-28T13:05:00.000Z",
    bookings: { ok: true, data: bookings() },
    whereFrom: { ok: true, data: { byChannel: [{ key: "organic_search", bookings: 4 }], topAirports: [{ key: "EWR", bookings: 2 }], landing: { blog: 5, airportPage: 0, homepage: 1, other: 0, none: 0 }, aiReferrals: 1, topBlogPosts: [{ path: "/blog/x", bookings: 2 }] } },
    funnel: { ok: true, data: funnel() },
    lostSales: { ok: true, data: { byStatus: { completed: 6 }, rows: [] } },
    engagement: { ok: true, data: { newsletterBySource: { blog: 2 }, waitlistByAirport: {}, chatSessions: 3, welcomeCodesMinted: 2 } },
    health: { ok: true, data: { telemetry: { kind: "ok", lastRowAt: "2026-09-28T03:58:00Z", rows24h: 500 }, snapshot: { kind: "off" }, stuckPending: { kind: "n", n: 0 }, emailNotSent: NO_UNSENT, lastDigest: { kind: "days", n: 1 } } },
    ...over,
  };
}

describe("model read — input allow-list and number validator", () => {
  it("the model input carries aggregates only: no lost-sales rows, no free text", () => {
    const d = data({ lostSales: { ok: true, data: { byStatus: { released_failed: 1 }, rows: [{ airport: "BNA", lot: "Lot", status: "released_failed", reason: "ada@example.com" }] } } });
    const json = JSON.stringify(modelInput(d));
    expect(json).not.toContain("example.com");
    expect(json).not.toContain("rows");
    expect(json).toContain('"released_failed":1');
  });

  it("accepts a read whose numbers are all in the input (incl. shares as percentages, window labels and the date)", () => {
    const input = modelInput(data());
    const allowed = allowedTokens(input, "2026-09-27");
    const text = "Six bookings on Sept 27 against a 7-day average of 5.2 and 28-day of 3.1; GMV was $604 and the Park Guard attach rate was 33%. Origin searches were 420. Worth a look: 1 AI-assistant referral.";
    expect(firstUnexplainedNumber(text, allowed)).toBeNull();
  });

  it("withholds a read with an invented amount or a derived percentage", () => {
    const allowed = allowedTokens(modelInput(data()), "2026-09-27");
    expect(firstUnexplainedNumber("Revenue reached $1,240 yesterday.", allowed)).toBe("$1,240");
    expect(firstUnexplainedNumber("Bookings were up 15% on the week.", allowed)).toBe("15%");
  });

  it("rejects a number with a magnitude or unit suffix the aggregates never carry (10k, 9am, 3x, $1.2k)", () => {
    const allowed = allowedTokens(modelInput(data()), "2026-09-27");
    expect(firstUnexplainedNumber("Revenue was near 10k yesterday.", allowed)).toBe("10k");
    expect(firstUnexplainedNumber("The spike came at 9am.", allowed)).toBe("9am");
    expect(firstUnexplainedNumber("GMV was roughly 3x the 7-day average.", allowed)).toBe("3x");
    expect(firstUnexplainedNumber("Bookings hit $1.2k.", allowed)).toBe("$1.2k");
    expect(firstUnexplainedNumber("Call it $10k.", allowed)).toBe("$10k");
    // harmless suffixes on an allowed number still pass: "7d", ordinals, percent
    expect(firstUnexplainedNumber("Over 7d the 28d trend held; the 1st booking came early.", allowed)).toBeNull();
  });

  it("lead-time bucket labels are not figures: '1–3 days' and '15+ days' pass, a bare 15% still fails", () => {
    const allowed = allowedTokens(modelInput(data()), "2026-09-27");
    expect(firstUnexplainedNumber("Most booked 1–3 days out; one was 15+ days ahead, none in the 4-14 day band.", allowed)).toBeNull();
    expect(firstUnexplainedNumber("Bookings were up 15% on the week.", allowed)).toBe("15%");
    expect(firstUnexplainedNumber("There were 41 cancellations.", allowed)).toBe("41");
    // without the day suffix these are figures, not labels
    expect(firstUnexplainedNumber("Fee income was $15+ per booking.", allowed)).toBe("$15");
    expect(firstUnexplainedNumber("Some 15+ bookings came from the blog.", allowed)).toBe("15");
  });

  it("accepts the zero-padded month of an echoed date and a 100% / 0% share", () => {
    const d = data({ bookings: { ok: true, data: bookings({ pgAttachRate: 1, count: { value: 1, avg7: 5, avg28: 3, since: "2026-02-19" } }) } });
    const allowed = allowedTokens(modelInput(d), "2026-09-27");
    expect(firstUnexplainedNumber("On 2026-09-27 the single booking took Park Guard: 100% attach.", allowed)).toBeNull();
    expect(firstUnexplainedNumber("Promo use was 0%.", allowed)).toBeNull();
  });

  it("does not pass an invented count just because its digits appear inside another number", () => {
    const allowed = allowedTokens(modelInput(data({ bookings: { ok: true, data: bookings({ gmv: 127.5 }) } })), "2026-09-27");
    // "75" sits inside "127.5" but is not itself a number in the input.
    expect(firstUnexplainedNumber("There were 75 bookings.", allowed)).toBe("75");
  });
});

describe("render — verdicts, flags, limits", () => {
  it("a clean day renders coral with no flags and every section", () => {
    const { embed, verdict, flags } = renderEmbed(data(), { kind: "ok", text: "Fine day." });
    expect(verdict.kind).toBe("ok");
    expect(flags).toEqual([]);
    expect(embed.color).toBe(0xf87356);
    expect(embed.fields.map((f) => f.name)).toEqual(["Bookings", "Fee income", "GMV", "Searches (server-side)", "No lot shown", "Park Guard", "Where bookings came from", "Lead time & extras", "Lost sales", "Search detail", "Engagement", "Health"]);
    expect(embed.fields.slice(0, 6).every((f) => f.inline)).toBe(true); // two rows of three tiles
    expect(embed.description).toBe("✅ No flags.\n\n_Read (Haiku, from the aggregates):_ Fine day."); // the read sits at the top, under the flags, attributed
    expect(embed.footer.text).toMatch(/GMV includes due-at-lot and is pre-discount/);
    expect(embed.footer.text).toMatch(/before ResLab's fee and before promo/);
    expect(embed.footer.text).toMatch(/engagement counts include staging/);
    expect(embed.title).toBe("📊 Triply daily — Sun Sept 27");
    expect(embed.fields[0].value).toMatch(/^\*\*6\*\*\n7-day avg 5\.2 · 28-day 3\.1$/);
    expect(embed.fields.find((f) => f.name === "Health")!.value).not.toMatch(/⚠️/); // snapshot "off" is neutral: no tick, no siren
    const healthy = data({ health: { ok: true, data: { telemetry: { kind: "ok", lastRowAt: "2026-09-28T03:58:00Z", rows24h: 500 }, snapshot: { kind: "row", ageHours: 2.1, behind: false, stale: false, locationCount: 391 }, stuckPending: { kind: "n", n: 0 }, emailNotSent: NO_UNSENT, lastDigest: { kind: "days", n: 1 } } } });
    expect(renderEmbed(healthy, null).embed.fields.find((f) => f.name === "Health")!.value).toBe("✅ telemetry ok (500 rows/24h) · snapshot 2.1 h, 391 lots · stuck pending 0 · emails unsent 0");
    expect(embed.footer.text).toContain("Sept 27, 2026");
  });

  it("one failed section ⇒ partial, red, section says unavailable with the reason", () => {
    const { embed, verdict } = renderEmbed(data({ engagement: { ok: false, error: "PGRST205" } }), null);
    expect(verdict.kind).toBe("partial");
    expect(embed.color).toBe(0xdc2626);
    expect(embed.title).toMatch(/partial/);
    expect(embed.fields.find((f) => f.name.startsWith("Engagement"))?.value).toBe("unavailable (PGRST205)");
  });

  it("bookings failing ⇒ COULD NOT RUN with NO digits in the body (nothing can be misread)", () => {
    const { embed, verdict } = renderEmbed(data({ bookings: { ok: false, error: "timeout" } }), null);
    expect(verdict.kind).toBe("could_not_run");
    expect(embed.fields).toEqual([]);
    expect(embed.title).toMatch(/COULD NOT RUN/);
    // the only digits allowed are the "n of m sections" count and the date
    const body = embed.description.replace(/\d of \d sections/, "").replace(/\d{4}-\d{2}-\d{2}/g, "");
    expect(/\d/.test(body)).toBe(false);
  });

  it("half the sections failing ⇒ could not run even with bookings ok", () => {
    const d = data({ funnel: { ok: false, error: "x" }, lostSales: { ok: false, error: "x" }, engagement: { ok: false, error: "x" } });
    expect(verdictFor(d).kind).toBe("could_not_run");
  });

  it("flags: half-of-baseline bookings (only when the baseline is covered), stale snapshot, failed lost sales, silent telemetry", () => {
    const d = data({
      bookings: { ok: true, data: bookings({ count: { value: 1, avg7: 5, avg28: 4, since: "2026-02-19" } }) },
      lostSales: { ok: true, data: { byStatus: { released_failed: 2 }, rows: [] } },
      health: { ok: true, data: { telemetry: { kind: "silent_7d" }, snapshot: { kind: "row", ageHours: 30, behind: true, stale: true, locationCount: 391 }, stuckPending: { kind: "n", n: 0 }, emailNotSent: NO_UNSENT, lastDigest: { kind: "none" } } },
    });
    const texts = flagsFor(d).map((f) => f.text);
    expect(texts.some((t) => /half the 7-day avg/.test(t))).toBe(true);
    expect(texts.some((t) => /2 lost sale/.test(t))).toBe(true);
    expect(texts.some((t) => /silent/.test(t))).toBe(true);
    expect(texts.some((t) => /stale/.test(t))).toBe(true);
    // a snapshot merely "behind" is a flag too (search already lost its long CDN TTL), not just a ⚠️ in a droppable line
    const behind = data({ health: { ok: true, data: { telemetry: { kind: "ok", lastRowAt: "2026-09-28T03:58:00Z", rows24h: 5 }, snapshot: { kind: "row", ageHours: 12, behind: true, stale: false, locationCount: 391 }, stuckPending: { kind: "n", n: 0 }, emailNotSent: NO_UNSENT, lastDigest: { kind: "days", n: 1 } } } });
    expect(flagsFor(behind).some((f) => /snapshot behind \(12 h\)/.test(f.text))).toBe(true);
    // uncovered baseline ⇒ the bookings flag is suppressed
    const d2 = data({ bookings: { ok: true, data: bookings({ count: { value: 0, avg7: null, avg28: null, since: "2026-02-19" } }) } });
    expect(flagsFor(d2).some((f) => /half the 7-day/.test(f.text))).toBe(false);
  });

  it("an embed that would exceed Discord's 6,000-char total is clamped by dropping low-priority fields, and says so", () => {
    const longRows = Array.from({ length: 40 }, (_, i) => ({ airport: "JFK", lot: "A very long lot name ".repeat(3), status: "released_failed", reason: "x".repeat(60) + i }));
    const d = data({
      lostSales: { ok: true, data: { byStatus: { released_failed: 40 }, rows: longRows } },
      whereFrom: { ok: true, data: { byChannel: Array.from({ length: 30 }, (_, i) => ({ key: `channel_${i}_${"z".repeat(20)}`, bookings: 1 })), topAirports: [], landing: { blog: 0, airportPage: 0, homepage: 0, other: 0, none: 0 }, aiReferrals: 0, topBlogPosts: Array.from({ length: 30 }, (_, i) => ({ path: `/blog/${"p".repeat(40)}${i}`, bookings: 1 })) } },
    });
    // Many flags make the description long; with the 1,024-clamped fields the total passes 6,000.
    d.funnel = { ok: true, data: funnel({ nothingBookableByAirport: Array.from({ length: 70 }, (_, i) => ({ key: `AP${i}`, share: 0.9, priced: 10 })) }) };
    const { embed, truncated } = renderEmbed(d, { kind: "ok", text: "t".repeat(900) });
    const total = embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(DISCORD_TOTAL_LIMIT);
    expect(embed.fields.length).toBeLessThanOrEqual(25);
    for (const f of embed.fields) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect(truncated).toBe(true);
    expect(embed.footer.text).toMatch(/truncated/);
  });

  it("more flags than fit are summarised, counted as truncation, and never silently dropped", () => {
    const d = data();
    d.funnel = { ok: true, data: funnel({ nothingBookableByAirport: Array.from({ length: 30 }, (_, i) => ({ key: `AP${i}`, share: 0.9, priced: 10 })) }) };
    const { embed, flags, truncated } = renderEmbed(d, null);
    expect(flags).toHaveLength(30);
    expect(embed.description).toMatch(/… and 10 more flag\(s\)/);
    expect(truncated).toBe(true);
    expect(embed.footer.text).toMatch(/truncated/);
  });

  it("a stale telemetry writer, an unreadable run log and a failed baseline are flags with the numbers still shown", () => {
    const d = data();
    d.health = { ok: true, data: { telemetry: { kind: "stale", lastRowAt: "2026-09-25T03:58:00Z", rows24h: 0 }, snapshot: { kind: "off" }, stuckPending: { kind: "n", n: 0 }, emailNotSent: NO_UNSENT, lastDigest: { kind: "error", message: "PGRST205 no table" } } };
    d.bookings = { ok: true, data: bookings({ count: { value: 6, avg7: null, avg28: null, since: "2026-02-19", baselineError: "statement timeout" } }) };
    const { embed, flags } = renderEmbed(d, null);
    const texts = flags.map((f) => f.text).join("\n");
    expect(texts).toMatch(/STALE.*2026-09-25 03:58 UTC.*0 rows\/24h/);
    expect(texts).toMatch(/run log unreadable/);
    expect(texts).toMatch(/baselines unavailable/);
    const health = embed.fields.find((f) => f.name === "Health")!.value;
    expect(health).toMatch(/last digest UNKNOWN/);
    expect(health).not.toMatch(/first digest|no earlier digest/);
    const b = embed.fields.find((f) => f.name === "Bookings")!.value;
    expect(b).toMatch(/^\*\*6\*\*\nbaselines unavailable/);
    expect(health).not.toMatch(/^✅/); // a warning line never gets the green tick
  });

  it("money totals going unavailable is a red flag, never a coral 'No flags.'", () => {
    const d = data({ bookings: { ok: true, data: bookings({ gmv: "unavailable", feeIncome: "unavailable", chargedOnline: "unavailable", unpricedRows: 1 }) } });
    const { embed, flags } = renderEmbed(d, null);
    expect(flags.map((f) => f.text).join("\n")).toMatch(/1 booking\(s\) with a NULL money column/);
    expect(embed.color).toBe(0xdc2626);
    const h = data({ health: { ok: true, data: { telemetry: { kind: "ok", lastRowAt: "2026-09-28T03:58:00Z", rows24h: 5 }, snapshot: { kind: "off" }, stuckPending: { kind: "error", message: "42501 permission denied" }, emailNotSent: NO_UNSENT, lastDigest: { kind: "none" } } } });
    const r2 = renderEmbed(h, null);
    expect(r2.flags.map((f) => f.text).join("\n")).toMatch(/stuck-pending check unavailable/);
    expect(r2.embed.fields.find((f) => f.name === "Health")!.value).toMatch(/stuck pending UNKNOWN \(42501/);
  });

  it("a day on which nothing priced, or most priced searches showed no lot, is RED — never 'No flags.'", () => {
    const outage = data({ funnel: { ok: true, data: funnel({ originSearches: { value: 3300, avg7: null, avg28: null, since: "2026-09-24" }, pricedSearches: 0, zeroResultShare: "unavailable", nothingBookableShare: "unavailable", lotSoldOutRate: "unavailable", degradedCount: 3300 }) } });
    const r1 = renderEmbed(outage, null);
    expect(r1.flags.map((f) => f.text).join("\n")).toMatch(/no search priced a single lot \(3300 origin searches\) — ResLab pricing or the location list/);
    expect(r1.flags.map((f) => f.text).join("\n")).not.toMatch(/was down/); // an observation, never a cause
    expect(r1.embed.color).toBe(0xdc2626);
    expect(r1.embed.fields.find((f) => f.name === "No lot shown")!.value).toBe("**n/a**\nnothing priced all day");
    expect(r1.embed.fields.find((f) => f.name === "Search detail")!.value).not.toMatch(/unavailable/);
    const swallowed = data({ funnel: { ok: true, data: funnel({ pricedSearches: 200, zeroResultShare: 0.9, nothingBookableShare: 0, nothingBookableDegraded: 3 }) } });
    const r2 = renderEmbed(swallowed, null);
    expect(r2.flags.map((f) => f.text).join("\n")).toMatch(/90% of priced searches showed the customer no lots at all/);
    expect(r2.embed.fields.find((f) => f.name === "Search detail")!.value).toMatch(/\+3 on degraded searches — ResLab, not inventory/);
    expect(r2.embed.fields.find((f) => f.name === "No lot shown")!.value).toMatch(/^\*\*90%\*\*\nof 200 priced/);
  });

  it("a failed funnel section shows its reason in every funnel tile; neutral health states get no green tick", () => {
    const { embed } = renderEmbed(data({ funnel: { ok: false, error: "PGRST205 relation search_events does not exist" } }), null);
    expect(embed.fields.find((f) => f.name === "Searches (server-side)")!.value).toMatch(/^\*\*n\/a\*\*\nPGRST205 relation search_events/);
    expect(embed.fields.find((f) => f.name === "No lot shown")!.value).toMatch(/^\*\*n\/a\*\*\nPGRST205/);
    const neutral = data({ health: { ok: true, data: { telemetry: { kind: "ok", lastRowAt: "2026-09-28T03:58:00Z", rows24h: 5 }, snapshot: { kind: "off" }, stuckPending: { kind: "n", n: 0 }, emailNotSent: NO_UNSENT, lastDigest: { kind: "none" } } } });
    const line = renderEmbed(neutral, null).embed.fields.find((f) => f.name === "Health")!.value;
    expect(line).not.toMatch(/^✅/);
    expect(line).not.toMatch(/⚠️/);
    expect(line).toMatch(/snapshot off · stuck pending 0 · emails unsent 0 · no earlier digest on record/);
    const lost = renderEmbed(data({ lostSales: { ok: true, data: { byStatus: { released_failed: 2 }, rows: [{ airport: "BNA", lot: "Lot", status: "released_failed", reason: "[email]" }] } } }), null).embed;
    expect(lost.fields.find((f) => f.name === "Lost sales")!.value).toMatch(/hold released \(ResLab rejected\) 2/);
    expect(lost.fields.find((f) => f.name === "Lost sales")!.value).not.toMatch(/Released failed/);
  });

  it("completed bookings with no confirmation email are a RED flag listing the numbers (both sources); a failed check is never 'none'", () => {
    const numbers = ["RTL854206", "TRP-7K2M9QXA", ...Array.from({ length: 10 }, (_, i) => `RTL8600${String(i).padStart(2, "0")}`)];
    const h = (emailNotSent: HealthSection["emailNotSent"]) =>
      data({ health: { ok: true, data: { telemetry: { kind: "ok", lastRowAt: "2026-09-28T03:58:00Z", rows24h: 500 }, snapshot: { kind: "off" }, stuckPending: { kind: "n", n: 0 }, emailNotSent, lastDigest: { kind: "days", n: 1 } } } });
    const r = renderEmbed(h({ kind: "n", n: 12, capped: false, numbers, lookbackDays: 7 }), null);
    const text = r.flags.map((f) => f.text).join("\n");
    expect(text).toMatch(/12 completed booking\(s\) in the last 7 days with no confirmation email sent: RTL854206, TRP-7K2M9QXA, /);
    expect(text).toMatch(/… \+2 more/); // 10 numbers printed, the count stays exact
    expect(r.embed.color).toBe(0xdc2626);
    expect(r.embed.description).toContain("TRP-7K2M9QXA"); // not redacted to TRP-[plate] on the way out
    expect(r.embed.fields.find((f) => f.name === "Health")!.value).toMatch(/⚠️ emails unsent 12/);
    const capped = renderEmbed(h({ kind: "n", n: 50, capped: true, numbers: numbers.slice(0, 2), lookbackDays: 7 }), null);
    expect(capped.flags.map((f) => f.text).join("\n")).toMatch(/^50\+ completed booking/m);
    const err = renderEmbed(h({ kind: "error", message: "57014 statement timeout" }), null);
    expect(err.flags.map((f) => f.text).join("\n")).toMatch(/confirmation-email check unavailable/);
    expect(err.embed.fields.find((f) => f.name === "Health")!.value).toMatch(/emails unsent UNKNOWN \(57014/);
    const none = renderEmbed(h(NO_UNSENT), null);
    expect(none.flags.map((f) => f.text).join("\n")).not.toMatch(/confirmation email/);
    // the model never sees reservation numbers (health is not in the allow-list)
    expect(JSON.stringify(modelInput(h({ kind: "n", n: 1, capped: false, numbers: ["TRP-7K2M9QXA"], lookbackDays: 7 })))).not.toContain("TRP-");
  });

  it("a could-not-run embed keeps the route's extra flags (e.g. the possible-duplicate warning)", () => {
    const { embed, flags } = renderEmbed(data({ bookings: { ok: false, error: "x" } }), null, [{ text: "digest run log unreadable before posting — this may be a duplicate" }]);
    expect(embed.description).toMatch(/may be a duplicate/);
    expect(flags).toHaveLength(1);
  });

  it("zero origin searches is flagged even before the 7-day baseline exists", () => {
    const d = data();
    d.funnel = { ok: true, data: funnel({ originSearches: { value: 0, avg7: null, avg28: null, since: "2026-09-24" } }) };
    d.health = { ok: true, data: { telemetry: { kind: "silent_7d" }, snapshot: { kind: "off" }, stuckPending: { kind: "n", n: 0 }, emailNotSent: NO_UNSENT, lastDigest: { kind: "none" } } };
    const { flags } = renderEmbed(d, null);
    expect(flags.map((f) => f.text).join("\n")).toMatch(/zero origin searches AND the search telemetry writer is silent or stale/);
  });

  it("a withheld or unavailable model read is a visible line, not an omission", () => {
    const a = renderEmbed(data(), { kind: "withheld", reason: "failed number check ($9)" }).embed;
    expect(a.description).toMatch(/_Read withheld \(failed number check \(\$9\)\)\._/);
    const b = renderEmbed(data(), { kind: "unavailable", reason: "timeout" }).embed;
    expect(b.description).toMatch(/_Read unavailable \(timeout\)\._/);
    expect(b.fields.some((f) => /Model read/.test(f.name))).toBe(false); // the read is never a field any more
  });
});
