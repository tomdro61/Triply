// Pure helpers for the pre-commit hook: which checks a set of staged files
// needs, and which review reminders apply. No I/O here, so it is unit-tested
// (lib.test.mjs, run in CI).

const BLOG_ENGINE = "scripts/blog-engine/";

// Files outside src/ that the app's typecheck or tests read.
const APP_ROOT_FILES = new Set(["package.json", "package-lock.json", "vercel.json", ".nvmrc"]);
const APP_ROOT_PATTERNS = [/^tsconfig[^/]*\.json$/, /^vitest\.[^/]+$/, /^next\.config\.[^/]+$/];
const TS_FILE = /\.(ts|tsx|mts)$/;

/** Forward slashes, no leading "./". */
export function normalize(file) {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Which check groups the staged files need.
 * - app: `next typegen`, tsc, vitest
 * - blogEngine: the engine's tsc + node:test files
 * - hooks: the hooks' own unit tests
 */
export function classify(files) {
  const need = { app: false, blogEngine: false, hooks: false };
  for (const raw of files) {
    const f = normalize(raw);
    if (!f) continue;
    if (f.startsWith(".githooks/") || f.startsWith(".claude/hooks/")) need.hooks = true;
    if (f.startsWith(BLOG_ENGINE)) {
      need.blogEngine = true;
      continue;
    }
    // The engine's booking links read this app file (booking-links.ts).
    if (f === "src/config/airports.ts") need.blogEngine = true;
    if (
      f.startsWith("src/") ||
      f.startsWith("supabase/migrations/") || // a schema test reads a migration file
      TS_FILE.test(f) || // the root tsconfig includes every .ts/.tsx/.mts
      APP_ROOT_FILES.has(f) ||
      APP_ROOT_PATTERNS.some((re) => re.test(f))
    ) {
      need.app = true;
    }
  }
  return need;
}

// Review reminders. Keep in step with:
//   FULL_SWEEP    → .claude/skills/scoped-review/SKILL.md "High-risk paths"
//   SCOPED_REVIEW → CLAUDE.md "When each check is required", the /scoped-review row
//   VERIFY_FLOW   → CLAUDE.md, the /verify-flow row
const FULL_SWEEP = [
  "src/app/api/checkout/",
  "src/app/api/reservations/",
  "src/app/api/webhooks/",
  "src/components/checkout/",
  "src/lib/stripe/",
  "src/lib/checkout/",
  "src/lib/booking/",
  "src/lib/cancellation/",
  "src/lib/promo/",
  "src/lib/parkguard/",
  "src/lib/direct/",
  "src/lib/auth/",
  "src/app/(main)/auth/",
  "src/lib/supabase/",
  "src/config/admin.ts",
  "supabase/migrations/",
  ".githooks/",
  ".claude/hooks/",
  ".claude/settings",
];
const SCOPED_REVIEW = [
  "src/app/api/",
  "src/lib/reslab/",
  "src/lib/resend/",
  "src/lib/validation/",
  "src/lib/utils/time.ts",
  "src/components/confirmation/",
  "src/components/lot/",
  "src/components/search/",
  "src/app/(main)/checkout/",
  "src/app/(main)/confirmation/",
  "src/app/(main)/admin/",
];
const VERIFY_FLOW = [
  "src/components/checkout/",
  "src/components/confirmation/",
  "src/components/lot/",
  "src/components/search/",
  "src/app/(main)/checkout/",
  "src/app/(main)/confirmation/",
  "src/lib/resend/",
];

const hits = (files, prefixes) => files.filter((f) => prefixes.some((p) => f.startsWith(p)));

/** Staged files grouped by the review they call for. A file is listed once, in its strictest group. */
export function reviewTiers(files) {
  const all = files.map(normalize).filter(Boolean);
  const fullSweep = hits(all, FULL_SWEEP);
  const scopedReview = hits(all, SCOPED_REVIEW).filter((f) => !fullSweep.includes(f));
  const verifyFlow = hits(all, VERIFY_FLOW);
  return { fullSweep, scopedReview, verifyFlow };
}

/** The reminder text printed after a passing commit; "" when no review path is staged. */
export function reviewReminder(files) {
  const { fullSweep, scopedReview, verifyFlow } = reviewTiers(files);
  if (!fullSweep.length && !scopedReview.length && !verifyFlow.length) return "";
  const list = (xs) => {
    const shown = xs.slice(0, 8).map((f) => `    ${f}`);
    if (xs.length > 8) shown.push(`    … and ${xs.length - 8} more`);
    return shown.join("\n");
  };
  const out = ["[pre-commit] Review owed before the PR (this hook cannot check it was run):"];
  if (fullSweep.length) out.push("  /scoped-review, FULL SWEEP (high-risk path):", list(fullSweep));
  if (scopedReview.length) out.push("  /scoped-review:", list(scopedReview));
  if (verifyFlow.length) out.push("  /verify-flow (customer-facing):", list(verifyFlow));
  return out.join("\n");
}

/** The last `max` lines of a check's output, for the failure message. */
export function tail(text, max = 60) {
  const lines = text.replace(/\r/g, "").trimEnd().split("\n");
  if (lines.length <= max) return lines.join("\n");
  return [`… (${lines.length - max} earlier lines cut)`, ...lines.slice(-max)].join("\n");
}
