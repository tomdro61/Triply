import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static import guards for Park & Stay (plan v3 §6 "No telemetry", R2-6):
 *
 * 1. No file under src/lib/hotels/** except hotel-lot-resolve.ts imports
 *    @/lib/reslab/search directly — and, stricter, none imports ANY
 *    @/lib/reslab/* module (types included): hotel-lot-resolve.ts is the one
 *    door to ResLab.
 * 2. Nothing under src/lib/hotels/** or the park-stay routes names
 *    `searchParking` or `getChannelLocationsCached` (the sweep and the parking
 *    telemetry live behind them).
 * 3. src/lib/booking/** never transitively reaches hotel-lot-resolve.ts (the
 *    location list must never be touched after a card is captured — the
 *    Aug-16 outage class).
 * 4. Every target file the rules name exists (a rename must not silently
 *    turn a rule into a no-op).
 * 5. No process.env under src/lib/hotels/** except flags.ts and liteapi/env.ts.
 *
 * Rules 1–2 are static; `search.test.ts` adds the runtime spy showing
 * logAvailability / logSearchEvent are called 0 times, because
 * getChannelLocationsNoSweep shares reslab/search.ts with them.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url)); // triply/
const SRC = join(ROOT, "src");
const HOTELS = join(SRC, "lib/hotels");
const PARK_STAY_ROUTES = join(SRC, "app/api/park-stay");
const PARK_STAY_PAGES = join(SRC, "app/(main)/park-stay");
const PARK_STAY_COMPONENTS = join(SRC, "components/park-stay");
const RESOLVE = join(HOTELS, "hotel-lot-resolve.ts");
const IMPORT_RE = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}
function importsOf(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(IMPORT_RE)].map((m) => m[1]);
}
function reachable(roots: string[], target: string): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  const offenders: string[] = [];
  while (queue.length) {
    const f = queue.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    if (f === target) {
      offenders.push(f);
      continue;
    }
    for (const spec of importsOf(f)) {
      const r = resolveImport(f, spec);
      if (r && !seen.has(r)) queue.push(r);
    }
  }
  return offenders;
}
const isResolve = (f: string) => resolve(f) === resolve(RESOLVE);
/** Source with block and line comments removed (strings are left alone — good enough for identifiers). */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("Park & Stay import guards", () => {
  const hotelFiles = walk(HOTELS);
  const routeFiles = walk(PARK_STAY_ROUTES);
  const pageFiles = existsSync(PARK_STAY_PAGES) ? walk(PARK_STAY_PAGES) : [];
  const componentFiles = existsSync(PARK_STAY_COMPONENTS) ? walk(PARK_STAY_COMPONENTS) : [];

  it("rule 4: every target the rules name exists", () => {
    for (const p of [
      RESOLVE,
      join(SRC, "lib/reslab/search.ts"),
      join(SRC, "lib/booking"),
      join(HOTELS, "search.ts"),
      join(PARK_STAY_ROUTES, "search/route.ts"),
      join(PARK_STAY_ROUTES, "hotel/route.ts"),
      join(HOTELS, "flags.ts"),
      join(HOTELS, "liteapi/env.ts"),
    ]) {
      expect(existsSync(p), p).toBe(true);
    }
    expect(hotelFiles.length).toBeGreaterThan(10);
    expect(routeFiles.length).toBeGreaterThanOrEqual(3);
  });

  it("rule 1: only hotel-lot-resolve.ts imports @/lib/reslab/* (search included)", () => {
    for (const f of [...hotelFiles, ...routeFiles, ...pageFiles, ...componentFiles]) {
      if (isResolve(f)) continue;
      const bad = importsOf(f).filter((spec) => {
        if (spec.startsWith("@/lib/reslab/")) return true;
        if (!spec.startsWith(".")) return false;
        const r = resolveImport(f, spec);
        return r !== null && /[\\/]lib[\\/]reslab[\\/]/.test(r);
      });
      expect(bad, `${f} imports ${bad.join(", ")}`).toEqual([]);
    }
  });

  it("rule 1 is not vacuous: hotel-lot-resolve.ts does import @/lib/reslab/search", () => {
    expect(importsOf(RESOLVE)).toContain("@/lib/reslab/search");
  });

  it("rule 2: no Park & Stay code names searchParking or getChannelLocationsCached (comments aside)", () => {
    for (const f of [...hotelFiles, ...routeFiles, ...pageFiles, ...componentFiles]) {
      const src = codeOnly(readFileSync(f, "utf8"));
      expect(/\bsearchParking\b/.test(src), `${f} names searchParking`).toBe(false);
      expect(/\bgetChannelLocationsCached\b/.test(src), `${f} names getChannelLocationsCached`).toBe(false);
    }
  });

  it("rule 3: the booking engine never transitively reaches hotel-lot-resolve.ts", () => {
    const roots = walk(join(SRC, "lib/booking"));
    expect(roots.length).toBeGreaterThan(0);
    expect(reachable(roots, resolve(RESOLVE))).toEqual([]);
  });

  it("rule 3 is not vacuous: the park-stay search route does reach hotel-lot-resolve.ts", () => {
    expect(reachable([join(PARK_STAY_ROUTES, "search/route.ts")], resolve(RESOLVE))).toHaveLength(1);
  });

  it("rule 5: no process.env under src/lib/hotels except flags.ts and liteapi/env.ts", () => {
    for (const f of hotelFiles) {
      if (/[\\/](flags|env)\.ts$/.test(f)) continue;
      expect(readFileSync(f, "utf8").includes("process.env"), `${f} reads process.env`).toBe(false);
    }
  });

  it("Park & Stay pages and components fire no GA4 search or funnel events", () => {
    for (const f of [...pageFiles, ...componentFiles]) {
      const src = readFileSync(f, "utf8");
      expect(/@\/lib\/analytics\//.test(src) || /\bgtag\b/.test(src), `${f} touches analytics`).toBe(false);
    }
  });
});
