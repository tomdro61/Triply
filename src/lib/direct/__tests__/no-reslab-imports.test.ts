import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static guard: src/lib/direct/** must never import anything under
 * src/lib/reslab — directly or transitively. The direct-lot store runs on the
 * fulfilment and pre-charge paths where the ResLab module's per-instance
 * location cache and 500/day budget must never be touched (the Aug-16 outage
 * class), and the two inventory sources must stay independent so a ResLab
 * outage cannot take direct lots down with it.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url)); // triply/
const SRC = join(ROOT, "src");
const FORBIDDEN = /(^|\/)reslab(\/|$)/;
const RESLAB_DIR = join(SRC, "lib", "reslab") + sep;
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
  else return null; // node_modules
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(IMPORT_RE)].map((m) => m[1]);
}

describe("src/lib/direct never reaches src/lib/reslab", () => {
  const files = walk(join(SRC, "lib/direct"));

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  const offends = (fromFile: string, spec: string): boolean =>
    FORBIDDEN.test(spec) || (resolveImport(fromFile, spec)?.startsWith(RESLAB_DIR) ?? false);

  it("directly", () => {
    const offenders = files.flatMap((f) => importsOf(f).filter((s) => offends(f, s)).map((s) => `${f} → ${s}`));
    expect(offenders).toEqual([]);
  });

  it("transitively", () => {
    const seen = new Set<string>();
    const offenders: string[] = [];
    const queue = files.map((f) => ({ file: f, via: [] as string[] }));
    while (queue.length) {
      const { file, via } = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of importsOf(file)) {
        if (offends(file, spec)) offenders.push([...via, file, spec].join(" → "));
        const target = resolveImport(file, spec);
        if (target && !seen.has(target)) queue.push({ file: target, via: [...via, file] });
      }
    }
    expect(offenders).toEqual([]);
  });
});
