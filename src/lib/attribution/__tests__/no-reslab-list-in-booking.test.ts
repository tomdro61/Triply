import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static guard for the Aug-16 outage class.
 *
 * The shared ResLab location list (getChannelLocationsCached in
 * @/lib/reslab/search, and findLotBySlug/getLotById in @/lib/reslab/get-lot)
 * is cached per lambda instance. The fulfilment bundles (webhook, return page,
 * sweep cron) never warm it, so a read from the booking engine would run a
 * ~54-page /locations sweep AFTER the customer's card was captured, inside a
 * 60 s function, against the 500/day budget that already took search down.
 *
 * A runtime mock cannot encode this (the list lives in a different module from
 * the mocked client), so assert it at the import level — directly AND
 * transitively (an import of @/lib/airport-page/data would reach it).
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url)); // triply/
const SRC = join(ROOT, "src");
const FORBIDDEN = /reslab\/(search|get-lot)(\.ts)?["']/;
const IMPORT_RE = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // node_modules
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) specs.push(m[1]);
  return specs;
}

describe("the booking engine must never reach the ResLab location list", () => {
  const roots = [join(SRC, "lib/booking"), join(SRC, "lib/attribution")];
  const files = roots.flatMap(walk);

  it("has files to scan (the guard is not a vacuous no-op)", () => {
    expect(files.length).toBeGreaterThan(2);
  });

  it("no direct import / require / dynamic import of the list modules", () => {
    for (const f of files) {
      for (const spec of importsOf(f)) {
        expect(FORBIDDEN.test(`${spec}"`), `${f} imports ${spec}`).toBe(false);
      }
    }
  });

  it("no TRANSITIVE import reaches them either (BFS over @/ and relative imports)", () => {
    const seen = new Set<string>();
    const queue = [...files];
    const offenders: string[] = [];
    while (queue.length) {
      const f = queue.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (/[\\/]lib[\\/]reslab[\\/](search|get-lot)\.ts$/.test(f)) {
        offenders.push(f);
        continue;
      }
      for (const spec of importsOf(f)) {
        const r = resolveImport(f, spec);
        if (r && !seen.has(r)) queue.push(r);
      }
    }
    expect(offenders, `reachable from the booking engine: ${offenders.join(", ")}`).toEqual([]);
  });
});
