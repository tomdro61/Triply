import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A-42 static guard (4b plan §3.5): code that serves or settles a booking that
 * EXISTS must never depend on the direct-lot listing — not the lot store (a CMS
 * read; fulfilment never re-reads the CMS, B9) and not ENABLE_DIRECT_LOTS (the
 * flag gates only NEW direct work, so turning it off can never strand money).
 * Checked transitively from each entry file.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url)); // triply/
const SRC = join(ROOT, "src");
const IMPORT_RE = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
const STORE = join(SRC, "lib", "direct", "store.ts");

const ENTRIES = [
  "lib/booking/create-booking.ts",
  "lib/booking/fulfill.ts",
  "app/api/reservations/[id]/route.ts",
  "app/api/reservations/route.ts",
  "app/api/reservations/complete/route.ts",
  "lib/cancellation/perform.ts",
  "lib/cancellation/finalize.ts",
  "lib/cancellation/reconcile.ts",
  "app/api/admin/bookings/cancel/route.ts",
  "app/api/webhooks/stripe/route.ts",
  "app/api/cron/sweep-pending-bookings/route.ts",
].map((p) => join(SRC, p));

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

/** Every first-party file reachable from `entry` (type-only imports included — stricter is fine here). */
function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, "utf8").matchAll(IMPORT_RE)) {
      const r = resolveImport(f, m[1]);
      if (r && !seen.has(r)) stack.push(r);
    }
  }
  return seen;
}

describe("booking / read / cancel paths never depend on the direct-lot listing", () => {
  it("entry files exist", () => {
    for (const e of ENTRIES) expect(existsSync(e), e).toBe(true);
    expect(readdirSync(join(SRC, "lib", "direct")).length).toBeGreaterThan(0);
  });

  it.each(ENTRIES.map((e) => [e.slice(SRC.length + 1), e]))("%s never reaches lib/direct/store (value import)", (_n, entry) => {
    const offenders = [...closure(entry)].filter((f) => {
      if (f === STORE) return false;
      // A type-only import of the store is erased at compile time.
      return [...readFileSync(f, "utf8").matchAll(/^import\s+(?!type\b)[^;]*from\s+["']([^"']+)["']/gm)].some(
        (m) => resolveImport(f, m[1]) === STORE
      );
    });
    expect(offenders).toEqual([]);
  });

  it.each(ENTRIES.map((e) => [e.slice(SRC.length + 1), e]))("%s never reads ENABLE_DIRECT_LOTS", (_n, entry) => {
    const offenders = [...closure(entry)].filter((f) => {
      if (f.endsWith(join("lib", "direct", "flag.ts"))) return false; // where it is defined
      const src = readFileSync(f, "utf8");
      return /ENABLE_DIRECT_LOTS|isDirectLotsEnabled\(/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
