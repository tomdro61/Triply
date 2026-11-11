#!/usr/bin/env node
/**
 * Every URL in the sitemap must be indexable. A noindexed URL in the sitemap
 * is what Search Console reports as "Excluded by noindex tag" (9 Nov 2026:
 * the zero-lot airport hubs a cold sitemap build listed).
 *
 * Walks the sitemap index, fetches each URL as Googlebot and fails if any
 * returns non-200, a noindex meta robots tag or an X-Robots-Tag noindex.
 *
 *   node scripts/check-sitemap-indexable.mjs [baseUrl] [--concurrency 4] [--limit N] [--all]
 *
 * Default baseUrl: https://www.triplypro.com. Exit 1 on any failure.
 *
 * By default it checks segments 0–3 only (static pages, airport pages, blog
 * hubs, blog categories). `--all` adds the lot segments (/sitemap/1xx.xml) and
 * blog post segments (/sitemap/2xx.xml): ~5,000 URLs, and each lot page costs
 * live ResLab calls (rate-limited) and each cold post a CMS read, so run it
 * with --all rarely and with a low --concurrency.
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const n = Number(args[i + 1]);
  // A missing, zero or non-numeric value must not become "check nothing, OK".
  if (!Number.isInteger(n) || n < 1) {
    console.error(`${name} needs a whole number of 1 or more (got "${args[i + 1] ?? ""}")`);
    process.exit(2);
  }
  return n;
};
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? "https://www.triplypro.com").replace(/\/$/, "");
const concurrency = flag("--concurrency", 4);
const limit = flag("--limit", Infinity);
const all = args.includes("--all");
const UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const TIMEOUT_MS = 30_000;

const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));

async function get(url) {
  const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { res, body: await res.text() };
}

/** Segment id of a child sitemap URL (/sitemap/100.xml -> 100), or null. */
const segmentId = (url) => {
  const m = /\/sitemap\/(\d+)\.xml$/.exec(url);
  return m ? Number(m[1]) : null;
};

async function sitemapUrls() {
  const { res, body } = await get(`${base}/sitemap.xml`);
  if (res.status !== 200) throw new Error(`sitemap.xml returned ${res.status}`);
  if (!body.includes("<sitemapindex")) return locs(body);
  const urls = [];
  for (const child of locs(body)) {
    const id = segmentId(child);
    if (!all && (id === null || id >= 100)) continue;
    const c = await get(child);
    if (c.res.status !== 200) throw new Error(`${child} returned ${c.res.status}`);
    urls.push(...locs(c.body));
  }
  return urls;
}

function problems(res, body) {
  const out = [];
  if (res.status !== 200) out.push(`status ${res.status}`);
  const header = res.headers.get("x-robots-tag");
  if (header && /noindex/i.test(header)) out.push(`X-Robots-Tag: ${header}`);
  for (const m of body.matchAll(/<meta[^>]+name=["'](?:robots|googlebot)["'][^>]*>/gi)) {
    if (/noindex/i.test(m[0])) out.push(m[0]);
  }
  return out;
}

const urls = [...new Set(await sitemapUrls())].slice(0, limit);
console.log(`Checking ${urls.length} sitemap URLs on ${base} (concurrency ${concurrency})`);

const failures = [];
let next = 0;
let done = 0;
async function worker() {
  while (next < urls.length) {
    const url = urls[next++];
    try {
      const { res, body } = await get(url);
      const p = problems(res, body);
      if (p.length) failures.push({ url, problems: p });
    } catch (error) {
      failures.push({ url, problems: [`fetch failed: ${error.message}`] });
    }
    if (++done % 500 === 0) console.log(`  ${done}/${urls.length}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

if (failures.length) {
  console.error(`\n${failures.length} sitemap URL(s) are not indexable:`);
  for (const f of failures) console.error(`  ${f.url}\n    ${f.problems.join("\n    ")}`);
  process.exit(1);
}
console.log(`OK: all ${urls.length} sitemap URLs return 200 with no noindex.`);
