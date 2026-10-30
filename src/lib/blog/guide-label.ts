// Short link text for blog guides listed on an airport booking page.
//
// Post titles carry lot prices and the year ("BWI Airport Parking from
// $6/day: 2026 Rates & Best Lots"). On the booking page those would sit under
// the live, fee-inclusive rates table: bare, stale lot prices that can
// contradict it, and a year that reads as out of date from January. So the
// label is the title's topic (before the colon) with prices and years
// removed; when that leaves too little ("LAX Parking"), or two guides would
// share a label, the whole title is used with prices and years removed.

const PRICE =
  /\s*(?:\b(?:from|under|starting at)\s+)?(?:\babout\s+)?(?:C\$|\$)\s?\d[\d.,]*(?:\s*[–-]\s*(?:C\$|\$)?\s?\d[\d.,]*)?(?:\s*(?:\/|per\s+)\s*(?:day|hr|hour|night|week))?(?:\s+max\b)?/gi;
const YEAR = /\s*\(?\b20\d\d\b\)?/g;

function strip(text: string): string {
  return text
    .replace(PRICE, "")
    .replace(YEAR, "")
    .replace(/\s*,\s*(?=[,:+&]|$)/g, "")
    .replace(/:\s*[,+&]\s*/g, ": ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s:,+&–-]+|[\s:,+&–-]+$/g, "")
    .trim();
}

function topic(title: string): string {
  return strip(title.split(":")[0]);
}

const MIN_TOPIC_WORDS = 3;

/** Labels for a list of guide titles, in the same order. */
export function guideLabels(titles: string[]): string[] {
  const labels = titles.map((t) => {
    const short = topic(t);
    return short.split(/\s+/).length >= MIN_TOPIC_WORDS ? short : strip(t);
  });
  const count = new Map<string, number>();
  for (const l of labels) count.set(l.toLowerCase(), (count.get(l.toLowerCase()) ?? 0) + 1);
  return labels.map((l, i) => ((count.get(l.toLowerCase()) ?? 0) > 1 ? strip(titles[i]) : l));
}
