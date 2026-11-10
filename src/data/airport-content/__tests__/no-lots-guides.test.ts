/**
 * The no-lots guides are shown only while an airport page has nothing to
 * book, so they must never claim Triply inventory, prices or bookings
 * (docs/review-lessons.md lesson 1), and Canadian pages quote C$ only.
 */
import { describe, it, expect } from "vitest";
import { getNoLotsAirportContent, NO_LOTS_GUIDE_CODES } from "../no-lots";
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

  it.runIf(CANADIAN.has(code))("quotes Canadian dollars as C$, never a bare $", async () => {
    const g = (await getNoLotsAirportContent(code))!;
    const text = [g.metaDescription, ...g.sections.map((s) => s.body), ...g.faqs.map((f) => f.answer)].join("\n");
    expect(text).not.toMatch(/(^|[^C])\$\d/);
  });
});
