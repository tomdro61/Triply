import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lock 2's static import guard (Park & Stay CX plan §7, as amended by §12.5
 * R12-H2). Customers must download exactly today's site, so the shared pages
 * — the homepage, /search, the shared and parking-search components and the
 * date picker — may STATICALLY reach Park & Stay code only through an
 * allowlist:
 *
 *   - src/components/park-stay/use-park-stay-access.ts (the access hook), and
 *   - the slot wrappers in src/components/park-stay/slots/.
 *
 * Those allowlisted files may themselves import, at runtime, only react,
 * next/dynamic, @/lib/supabase/client and each other; type-only imports are
 * free (erased at build). Everything that names Park & Stay is reached only
 * through a dynamic import() from a slot, into src/components/park-stay/entry/.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url)); // triply/
const SRC = join(ROOT, "src");
const PARK_STAY = join(SRC, "components/park-stay");
const SLOTS = join(PARK_STAY, "slots");
const ENTRY = join(PARK_STAY, "entry");
const HOOK = join(PARK_STAY, "use-park-stay-access.ts");
const HOTELS = join(SRC, "lib/hotels");

const SHARED_ROOTS = [
  join(SRC, "app/(main)/page.tsx"),
  join(SRC, "app/(main)/search"),
  join(SRC, "components/shared"),
  join(SRC, "components/search"),
  join(SRC, "components/ui/date-picker.tsx"),
];

const ALLOWED_RUNTIME_SPECS = new Set(["react", "next/dynamic", "@/lib/supabase/client"]);

function walk(p: string): string[] {
  if (!existsSync(p)) return [];
  if (statSync(p).isFile()) return /\.tsx?$/.test(p) ? [p] : [];
  const out: string[] = [];
  for (const name of readdirSync(p)) {
    if (name === "__tests__") continue;
    out.push(...walk(join(p, name)));
  }
  return out;
}

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

interface Imports {
  /** Static imports that survive compilation. */
  runtime: string[];
  /** `import type` / all-`type` specifier lists (erased). */
  typeOnly: string[];
  /** `import("…")`. */
  dynamic: string[];
}

function parseImports(source: string): Imports {
  const src = stripComments(source);
  const out: Imports = { runtime: [], typeOnly: [], dynamic: [] };
  const STATIC_RE = /\b(import|export)\s+(type\s+)?(?:([\w*\s{},$]*?)\s+from\s+)?["']([^"']+)["']/g;
  for (const m of src.matchAll(STATIC_RE)) {
    const typeKeyword = Boolean(m[2]);
    const clause = (m[3] ?? "").trim();
    const spec = m[4];
    const braces = /^\{([\s\S]*)\}$/.exec(clause);
    const allTypeSpecifiers =
      braces !== null &&
      braces[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .every((s) => s.startsWith("type "));
    if (typeKeyword || allTypeSpecifiers) out.typeOnly.push(spec);
    else out.runtime.push(spec);
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.dynamic.push(m[1]);
  return out;
}

function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return resolve(cand);
  }
  return null;
}

const under = (file: string, dir: string) => {
  const rel = relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
};
const isAllowlisted = (file: string) => resolve(file) === resolve(HOOK) || under(file, SLOTS);
const isParkStayCode = (file: string) => under(file, PARK_STAY) || under(file, HOTELS);

/** Every file statically (runtime) reachable from the roots. */
function reachableRuntime(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = roots.map((r) => resolve(r));
  while (queue.length) {
    const f = queue.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of parseImports(readFileSync(f, "utf8")).runtime) {
      const r = resolveImport(f, spec);
      if (r && !seen.has(r)) queue.push(r);
    }
  }
  return seen;
}

const rel = (f: string) => relative(ROOT, f).split(sep).join("/");

describe("parseImports (the guard's own parser)", () => {
  it("tells runtime, type-only and dynamic imports apart, across lines and comments", () => {
    const src = [
      `import { useState } from "react";`,
      `import type { A } from "@/lib/hotels/access";`,
      `import { type B, type C } from "./b";`,
      `import {`,
      `  x,`,
      `  type Y,`,
      `} from "./mixed";`,
      `import "./side-effect.css";`,
      `export { z } from "./re-export";`,
      `export type { W } from "./types-only";`,
      `// import { hidden } from "./commented";`,
      `const L = dynamic(() => import(/* chunk */ "./lazy").then((m) => m.L));`,
    ].join("\n");
    expect(parseImports(src)).toEqual({
      runtime: ["react", "./mixed", "./side-effect.css", "./re-export"],
      typeOnly: ["@/lib/hotels/access", "./b", "./types-only"],
      dynamic: ["./lazy"],
    });
  });
});

describe("shared pages reach Park & Stay only through the allowlist (R12-H2)", () => {
  const roots = SHARED_ROOTS.flatMap(walk);

  it("every root exists", () => {
    for (const r of SHARED_ROOTS) expect(existsSync(r), r).toBe(true);
    expect(existsSync(HOOK)).toBe(true);
    expect(roots.length).toBeGreaterThan(10);
  });

  it("no Park & Stay or src/lib/hotels file is statically reachable except the hook and the slot wrappers", () => {
    const offenders = [...reachableRuntime(roots)].filter((f) => isParkStayCode(f) && !isAllowlisted(f)).map(rel);
    expect(offenders).toEqual([]);
  });

  it("the allowlisted files import at runtime only react, next/dynamic, the browser Supabase client and each other", () => {
    for (const f of [HOOK, ...walk(SLOTS)]) {
      const bad = parseImports(readFileSync(f, "utf8")).runtime.filter((spec) => {
        if (ALLOWED_RUNTIME_SPECS.has(spec)) return false;
        const r = resolveImport(f, spec);
        return r === null || !isAllowlisted(r);
      });
      expect(bad, `${rel(f)} imports ${bad.join(", ")}`).toEqual([]);
    }
  });

  it("a slot's dynamic import() targets only src/components/park-stay/entry/", () => {
    for (const f of walk(SLOTS)) {
      for (const spec of parseImports(readFileSync(f, "utf8")).dynamic) {
        const r = resolveImport(f, spec);
        expect(r !== null && under(r, ENTRY), `${rel(f)} lazy-loads ${spec}`).toBe(true);
      }
    }
  });
});
