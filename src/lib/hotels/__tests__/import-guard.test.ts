import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static import guards for Park & Stay (plan §2.1):
 *
 * 1. `src/lib/hotels/pairing.ts` is the ONLY hotels module allowed to import the
 *    ResLab location-list modules, and only their types.
 * 2. `src/lib/booking/**` must never transitively reach `pairing.ts` (the list
 *    is a per-lambda cache whose cold build is a ~54-page sweep — never after
 *    a card is captured; the Aug-16 outage class).
 * 3. No `process.env` under `src/lib/hotels/**` except `flags.ts` and
 *    `liteapi/env.ts`: pricing stays pure and testable, and the hotels mode
 *    can only come from one predicate.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url)); // triply/
const SRC = join(ROOT, "src");
const HOTELS = join(SRC, "lib/hotels");
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
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(IMPORT_RE)].map((m) => m[1]);
}
function reachable(roots: string[], target: RegExp): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  const offenders: string[] = [];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (target.test(f)) {
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

describe("Park & Stay import guards", () => {
  const hotelFiles = walk(HOTELS);

  it("has files to scan", () => {
    expect(hotelFiles.length).toBeGreaterThan(5);
  });

  it("only pairing.ts may reach the ResLab location-list modules", () => {
    for (const f of hotelFiles) {
      if (/[\\/]pairing\.ts$/.test(f)) continue;
      const hits = reachable([f], /[\\/]lib[\\/]reslab[\\/](search|get-lot)\.ts$/);
      expect(hits, `${f} reaches ${hits.join(", ")}`).toEqual([]);
    }
  });

  it("the booking engine never transitively reaches pairing.ts", () => {
    const roots = walk(join(SRC, "lib/booking"));
    const hits = reachable(roots, /[\\/]lib[\\/]hotels[\\/]pairing\.ts$/);
    expect(hits).toEqual([]);
  });

  it("no process.env under src/lib/hotels except flags.ts and liteapi/env.ts", () => {
    for (const f of hotelFiles) {
      if (/[\\/](flags|env)\.ts$/.test(f)) continue;
      expect(readFileSync(f, "utf8").includes("process.env"), `${f} reads process.env`).toBe(false);
    }
  });
});
