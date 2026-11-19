import { describe, it, expect } from "vitest";
import { getAirportContent } from "../index";

/**
 * The nine guides written 19 Nov 2026 for the airport pages that sat just off
 * page 1. Off-site lot prices change daily, so the copy names our lots but
 * never prices them: dollar figures are the airport's own rates, fees and
 * fares. The lot names below are the lots these guides describe.
 */
const LOTS: Record<string, string[]> = {
  ORF: ["Econo Lodge"],
  CHS: ["Embassy Suites"],
  RNO: ["SureStay", "Best Western"],
  OAK: ["Airpark", "Spring Park", "Express Park"],
  SJC: ["Spring Park", "Holiday Inn", "Joy Park"],
  RIC: ["Sheraton", "Best Western", "DoubleTree"],
  SYR: ["Candlewood"],
  CVG: ["Quality Inn", "Holiday Inn", "Hyatt Place", "Hilton"],
  DSM: ["Clarion"],
};

describe.each(Object.keys(LOTS))("%s guide", (code) => {
  it("exists, with a meta description Google won't cut", async () => {
    const c = await getAirportContent(code);
    expect(c).not.toBeNull();
    expect(c!.metaDescription.length).toBeLessThanOrEqual(160);
  });

  it("never puts a dollar figure in a sentence that names one of our lots", async () => {
    const c = (await getAirportContent(code))!;
    const text = [c.metaDescription, ...c.sections.flatMap((s) => [s.heading, s.body]), ...c.faqs.flatMap((f) => [f.question, f.answer])].join("\n");
    const sentences = text.split(/(?<=[.!?])\s+|\n+/);
    for (const s of sentences) {
      if (!s.includes("$")) continue;
      for (const name of LOTS[code]) expect(s, s).not.toContain(name);
    }
  });
});
