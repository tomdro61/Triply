import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, reviewReminder, reviewTiers, tail } from "./lib.mjs";

test("docs-only commits need no checks", () => {
  assert.deepEqual(classify(["CLAUDE.md", "docs/review-lessons.md", "public/logo.png", ".claude/skills/x/SKILL.md"]), {
    app: false,
    blogEngine: false,
    hooks: false,
  });
});

test("app sources and the files its typecheck and tests read need the app checks", () => {
  for (const f of [
    "src/lib/stripe/client.ts",
    "src\\components\\checkout\\checkout-form.tsx",
    "scripts/resync-orphan-booking.ts",
    "scripts/digest-read-probe.mts",
    "sentry.server.config.ts",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vitest.config.ts",
    "vitest.setup.ts",
    "next.config.mjs",
    "vercel.json",
    ".nvmrc",
    "supabase/migrations/052_x.sql",
  ]) {
    assert.equal(classify([f]).app, true, f);
  }
});

test("a plain script outside src does not trigger the app checks", () => {
  assert.equal(classify(["scripts/apply-migration-031.mjs"]).app, false);
});

test("blog-engine files need only the engine checks", () => {
  assert.deepEqual(classify(["scripts/blog-engine/src/queue.ts", "scripts/blog-engine/package.json"]), {
    app: false,
    blogEngine: true,
    hooks: false,
  });
});

test("the airports config is read by the engine, so it needs both", () => {
  assert.deepEqual(classify(["src/config/airports.ts"]), { app: true, blogEngine: true, hooks: false });
});

test("hook files run the hook tests", () => {
  assert.equal(classify([".githooks/pre-commit.mjs"]).hooks, true);
  assert.equal(classify([".claude/hooks/guard-lib.mjs"]).hooks, true);
  assert.equal(classify([".claude/settings.json"]).hooks, false);
});

test("review tiers: a file is listed once, in its strictest group", () => {
  const t = reviewTiers([
    "src/app/api/checkout/route.ts",
    "src/app/api/lots/quote/route.ts",
    "src/lib/reslab/search.ts",
    "src/components/checkout/checkout-form.tsx",
    "src/app/(main)/auth/callback/route.ts",
    ".claude/settings.json",
    "README.md",
  ]);
  assert.deepEqual(t.fullSweep, [
    "src/app/api/checkout/route.ts",
    "src/components/checkout/checkout-form.tsx",
    "src/app/(main)/auth/callback/route.ts",
    ".claude/settings.json",
  ]);
  assert.deepEqual(t.scopedReview, ["src/app/api/lots/quote/route.ts", "src/lib/reslab/search.ts"]);
  assert.deepEqual(t.verifyFlow, ["src/components/checkout/checkout-form.tsx"]);
});

test("no reminder when no review path is staged", () => {
  assert.equal(reviewReminder(["README.md", "src/components/blog/card.tsx"]), "");
});

test("the reminder names the review and caps a long list", () => {
  const many = Array.from({ length: 11 }, (_, i) => `src/lib/stripe/f${i}.ts`);
  const text = reviewReminder(many);
  assert.match(text, /FULL SWEEP/);
  assert.match(text, /… and 3 more/);
  assert.doesNotMatch(text, /verify-flow/);
});

test("tail keeps the last lines and says how many were cut", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\r\n");
  const out = tail(text, 10).split("\n");
  assert.equal(out.length, 11);
  assert.equal(out[0], "… (90 earlier lines cut)");
  assert.equal(out.at(-1), "line 99");
  assert.equal(tail("a\nb", 10), "a\nb");
});
