/**
 * The no-lots guides are shown only while an airport page has nothing to
 * book, so they must never claim Triply inventory, prices or bookings
 * (docs/review-lessons.md lesson 1), and Canadian pages quote C$ only.
 */
import { describe, it, expect } from "vitest";
import { getNoLotsAirportContent, loadRawNoLotsGuide, NO_LOTS_GUIDE_CODES } from "../no-lots";
import { getAirportByCode } from "@/config/airports";

const CANADIAN = new Set(["YOW", "YUL", "YYC", "YYZ"]);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

describe.each(NO_LOTS_GUIDE_CODES)("no-lots guide %s", (code) => {
  it("is a real airport with dated, non-empty copy", async () => {
    expect(getAirportByCode(code)).toBeDefined();
    const g = await getNoLotsAirportContent(code);
    expect(g).not.toBeNull();
    expect(g!.publishedOn).toMatch(ISO);
    expect(g!.updatedOn).toMatch(ISO);
    expect(g!.sections.length).toBeGreaterThanOrEqual(2);
    expect(g!.faqs.length).toBeGreaterThanOrEqual(4);
    expect(g!.metaDescription.length).toBeLessThanOrEqual(200);
  });

  it("never claims Triply lots, prices or bookings", async () => {
    const g = (await getNoLotsAirportContent(code))!;
    const text = [g.metaDescription, ...g.sections.flatMap((s) => [s.heading, s.body]), ...g.faqs.flatMap((f) => [f.question, f.answer])].join("\n");
    expect(text).not.toMatch(/\bon Triply\b|\bTriply (lot|price|rate)s?\b|book now|free cancellation|reserve with us/i);
  });

  it("never ranks a 'cheapest' option: the sources cover only the airport's own parking", async () => {
    const g = (await getNoLotsAirportContent(code))!;
    const text = [g.metaDescription, ...g.sections.flatMap((s) => [s.heading, s.body]), ...g.faqs.flatMap((f) => [f.question, f.answer])].join("\n");
    expect(text).not.toMatch(/cheapest/i);
  });

  it("never leaks the showUntil field into the page", async () => {
    const g = (await getNoLotsAirportContent(code))!;
    for (const item of [...g.sections, ...g.faqs]) expect(item).not.toHaveProperty("showUntil");
  });

  it.runIf(CANADIAN.has(code))("quotes Canadian dollars as C$, never a bare $", async () => {
    const g = (await getNoLotsAirportContent(code))!;
    const text = [g.metaDescription, ...g.sections.map((s) => s.body), ...g.faqs.map((f) => f.answer)].join("\n");
    expect(text).not.toMatch(/(^|[^C])\$\d/);
  });
});

describe("dated guide content (showUntil)", () => {
  const rswText = async (iso: string) => {
    const g = (await getNoLotsAirportContent("RSW", new Date(iso)))!;
    return [g.metaDescription, ...g.sections.flatMap((s) => [s.heading, s.body]), ...g.faqs.flatMap((f) => [f.question, f.answer])].join("\n");
  };

  it("shows RSW's Thanksgiving lot through Sunday 29 Nov 2026, airport time", async () => {
    // 23:30 on the 29th in Fort Myers is already the 30th in UTC.
    expect(await rswText("2026-11-30T04:30:00Z")).toMatch(/RSWRemote/);
  });

  it("drops it, section and FAQ, from Monday 30 Nov 2026", async () => {
    const text = await rswText("2026-11-30T05:30:00Z");
    expect(text).not.toMatch(/RSWRemote|Thanksgiving/);
  });

  it("never names the dated lot in the meta description, which has no date gate", async () => {
    const g = (await getNoLotsAirportContent("RSW", new Date("2026-11-10T12:00:00Z")))!;
    expect(g.metaDescription).not.toMatch(/RSWRemote|Thanksgiving/);
  });
});

describe.each(NO_LOTS_GUIDE_CODES)("no-lots guide %s — showUntil values", (code) => {
  // A string comparison decides what shows, so a typo ("29 Nov 2026",
  // "2026-12-1") would keep dated content up for good, silently.
  it("every showUntil is a real calendar date written YYYY-MM-DD", async () => {
    const raw = (await loadRawNoLotsGuide(code))!;
    for (const item of [...raw.sections, ...raw.faqs]) {
      if (item.showUntil === undefined) continue;
      expect(item.showUntil).toMatch(ISO);
      const d = new Date(`${item.showUntil}T00:00:00Z`);
      expect(d.toISOString().slice(0, 10)).toBe(item.showUntil);
    }
  });
});
