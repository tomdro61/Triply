/**
 * Checkout smoke test: runs on a PR's own preview and STOPS BEFORE PAY.
 *
 * What it proves: the preview is up, checkout loads a lot and a price, both
 * form steps advance, the server creates a PaymentIntent, Stripe's form
 * mounts, and the amount on the pay button equals what the server computed
 * and what Stripe holds, before and after a protection plan is picked.
 *
 * What it never does: type a card, click Pay, call /api/search, or reach
 * anything that writes to the (production) database. lib/guard.ts enforces
 * that; do not loosen it to make a test pass.
 *
 * Not covered (still the manual `/verify-flow checkout` walk): authorization,
 * the reservation, capture, the confirmation page, emails, wallets.
 */
import { test as base, expect, type Page, type Response } from "@playwright/test";
import { installGuard, type Guard } from "./lib/guard";
import { failure, previewOrigin, previewToken, TRUSTED_TOKEN_HEADER } from "./lib/preview-access";

/** ResLab TEST lot (src/config/admin.ts). Loads on previews, refused in production. */
const TEST_LOT = "reslab-194";

const test = base.extend<{ guard: Guard }>({
  // Every test gets the guard before its first navigation, and fails on a violation.
  guard: [
    async ({ context }, provide) => {
      const guard = await installGuard(context, previewOrigin());
      await provide(guard);
      expect(guard.violations, "the page tried something this test must never do").toEqual([]);
    },
    { auto: true },
  ],
  baseURL: async ({}, provide) => {
    await provide(previewOrigin().origin);
  },
});

/** A date `days` from today as YYYY-MM-DD (the URL format; no time-zone maths on booking times). */
function dayFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function checkoutUrl(withTimes: boolean): string {
  const params = new URLSearchParams({ lot: TEST_LOT, checkin: dayFromNow(30), checkout: dayFromNow(34) });
  if (withTimes) {
    params.set("checkinTime", "8:00 AM");
    params.set("checkoutTime", "8:00 AM");
  }
  return `/checkout?${params}`;
}

const cents = (dollars: number) => Math.round(dollars * 100);

/** The dollar amount on the pay button, in cents. Waits for a settled label. */
async function payButtonCents(page: Page): Promise<number> {
  const button = page.getByRole("button", { name: /(Pay Now|Complete Booking) - \$/ });
  await expect(button).toBeVisible();
  const text = (await button.textContent()) ?? "";
  const match = /\$([\d,]+\.\d{2})/.exec(text);
  if (!match) throw failure("APP", `the pay button shows no amount: "${text.trim()}"`);
  return cents(Number(match[1].replace(/,/g, "")));
}

/** What Stripe itself holds for the PaymentIntent, read with the page's own publishable (test) key. */
async function stripeAmountCents(publishableKey: string, paymentIntentId: string, clientSecret: string): Promise<number> {
  const response = await fetch(
    `https://api.stripe.com/v1/payment_intents/${paymentIntentId}?client_secret=${encodeURIComponent(clientSecret)}`,
    { headers: { authorization: `Bearer ${publishableKey}` } }
  );
  if (!response.ok) throw failure("UPSTREAM", `Stripe would not return the PaymentIntent (HTTP ${response.status})`);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("amount" in body) || typeof body.amount !== "number") {
    throw failure("UPSTREAM", "Stripe's PaymentIntent had no amount");
  }
  return body.amount;
}

const isPost = (response: Response, pathname: string) =>
  response.request().method() === "POST" && new URL(response.url()).pathname === pathname;

test("the preview is reachable with this job's credential and serves a static page", async ({ page }) => {
  // Asked from Node first, so a credential problem reads as CONFIG, not as a broken page.
  const probe = await fetch(new URL("/terms", previewOrigin()), {
    headers: { [TRUSTED_TOKEN_HEADER]: await previewToken() },
    redirect: "manual",
  });
  if (probe.status === 401 || probe.status === 403 || (probe.status >= 300 && probe.status < 400)) {
    throw failure(
      "CONFIG",
      `Vercel did not accept this job's identity (HTTP ${probe.status}). Check the project's Trusted Sources rule for this repository (Preview).`
    );
  }
  if (probe.status >= 500) throw failure("APP", `/terms returned HTTP ${probe.status} on the preview`);

  // /terms, not the home page: the home page's featured lots call /api/search.
  await page.goto("/terms");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("checkout refuses a link with no times, before asking the server", async ({ page }) => {
  let askedServer = false;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/checkout/lot") askedServer = true;
  });
  await page.goto(checkoutUrl(false));
  await expect(page.getByText("Unable to Load Checkout")).toBeVisible();
  expect(askedServer, "a checkout with no times must not be priced").toBe(false);
});

test("checkout reaches the payment form and the amount agrees three ways", async ({ page, guard }) => {
  const runId = process.env.GITHUB_RUN_ID ?? "local";

  // ── 1. The lot and a price load ────────────────────────────────────────
  const lotLoad = page.waitForResponse(
    (response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/checkout/lot"
  );
  await page.goto(checkoutUrl(true));
  const lotResponse = await lotLoad;
  if (lotResponse.status() >= 500) {
    throw failure(
      "UPSTREAM",
      `/api/checkout/lot returned HTTP ${lotResponse.status()}: staging ResLab is the usual cause; if it is up, this is ours (read the preview's logs)`
    );
  }
  if (!lotResponse.ok()) throw failure("APP", `/api/checkout/lot returned HTTP ${lotResponse.status()} for the test lot`);
  const lotData = await lotResponse.json();
  const lotName: string = lotData?.lot?.name ?? "";
  // Also proves this is a preview: production refuses the test lots.
  expect(lotName, "the test lot's name starts with TEST").toMatch(/^TEST/i);
  if (lotData?.costData?.soldOut) throw failure("UPSTREAM", "test lot 194 is sold out on staging ResLab for these dates");
  expect(lotData?.costData?.dueNow, "the server priced the stay").toBeGreaterThan(0);

  // ── 2. Both form steps advance ─────────────────────────────────────────
  const field = (name: string) => page.locator(`[data-funnel-field="${name}"]`);
  await expect(field("firstName")).toBeVisible();
  await field("firstName").fill("Smoke");
  await field("lastName").fill("Test");
  // example.com never delivers mail.
  await field("email").fill(`ci-smoke+${runId}@example.com`);
  await field("phone").fill("6175550123");
  await page.getByRole("button", { name: "Continue to Vehicle Info" }).click();

  await expect(field("make")).toBeVisible();
  await field("make").fill("Toyota");
  await field("model").fill("Camry");
  await field("color").selectOption("Blue");
  await field("licensePlate").fill("SMOKE1");
  await field("state").selectOption("MA");
  // Whatever else the lot asks for. A flight field is format-checked; plain text takes N/A.
  const extras = page.locator('[data-funnel-field^="extra:"]');
  for (let i = 0; i < (await extras.count()); i++) {
    const extra = extras.nth(i);
    const name = ((await extra.getAttribute("data-funnel-field")) ?? "").toLowerCase();
    const type = await extra.getAttribute("type");
    await extra.fill(name.includes("flight") ? "UA123" : type === "number" ? "1" : "N/A");
  }

  const intentCreated = page.waitForResponse((response) => isPost(response, "/api/checkout/lot"));
  await page.getByRole("button", { name: "Continue to Payment" }).click();
  const intentResponse = await intentCreated;
  if (intentResponse.status() >= 500) {
    throw failure(
      "UPSTREAM",
      `creating the PaymentIntent returned HTTP ${intentResponse.status()}: staging ResLab or Stripe is the usual cause; if both are up, this is ours`
    );
  }
  if (!intentResponse.ok()) throw failure("APP", `creating the PaymentIntent returned HTTP ${intentResponse.status()}`);
  const intent = await intentResponse.json();
  const parkingOnlyCents: number = intent.chargeCents;
  expect(Number.isInteger(parkingOnlyCents) && parkingOnlyCents > 0, "the server returned a charge in cents").toBe(true);
  expect(String(intent.paymentIntentId)).toMatch(/^pi_/);

  // ── 3. Stripe's form mounts; the amount agrees three ways ──────────────
  await expect(page.getByRole("heading", { name: "Payment" })).toBeVisible();
  await expect(page.locator('iframe[title="Secure payment input frame"]').first()).toBeAttached({ timeout: 30_000 });
  // Nothing is pre-selected: no amount on the button until the customer chooses.
  await expect(page.getByRole("button", { name: "Select a protection option above" })).toBeDisabled();

  const stripeHolds = async () => {
    await expect
      .poll(() => guard.publishableKey(), { message: "the page calls Stripe with a test publishable key" })
      .not.toBeNull();
    const key = guard.publishableKey();
    if (!key) throw failure("APP", "the page never called Stripe with a test publishable key");
    return stripeAmountCents(key, intent.paymentIntentId, intent.clientSecret);
  };
  expect(await stripeHolds(), "Stripe holds what the server said it would charge").toBe(parkingOnlyCents);

  /** Pick an option; return the server's new amount once Stripe has it. */
  const choose = async (value: "A" | "B" | "C" | "none") => {
    const updated = page.waitForResponse((response) => isPost(response, "/api/checkout/lot/update-pi"));
    await page.locator(`input[type="radio"][value="${value}"]`).check();
    const response = await updated;
    if (!response.ok()) throw failure("APP", `update-pi returned HTTP ${response.status()} for "${value}"`);
    return cents((await response.json()).amount);
  };

  // A plan: the charge rises by exactly the price printed on its card.
  const planCard = page.locator("label", { has: page.locator('input[type="radio"][value="C"]') });
  const printed = /\$(\d+\.\d{2})/.exec((await planCard.textContent()) ?? "");
  if (!printed) throw failure("APP", "the Plan C card shows no price");
  const withPlanCents = await choose("C");
  expect(withPlanCents - parkingOnlyCents, "the plan costs what its card says").toBe(cents(Number(printed[1])));
  await expect
    .poll(() => payButtonCents(page), { message: "the pay button shows the amount with the plan" })
    .toBe(withPlanCents);
  expect(await stripeHolds(), "Stripe holds the amount with the plan").toBe(withPlanCents);

  // No protection: back to the parking-only charge, everywhere.
  const withoutPlanCents = await choose("none");
  expect(withoutPlanCents, "declining the plan returns to the parking-only charge").toBe(parkingOnlyCents);
  await expect
    .poll(() => payButtonCents(page), { message: "the pay button shows the parking-only amount" })
    .toBe(parkingOnlyCents);
  expect(await stripeHolds(), "Stripe holds the parking-only amount").toBe(parkingOnlyCents);

  // Pay becomes available once the terms are accepted (no card needed for that).
  // It is checked, never clicked.
  await page.locator("label", { hasText: "I agree to the" }).getByRole("checkbox").check();
  await expect(page.getByRole("button", { name: /(Pay Now|Complete Booking) - \$/ })).toBeEnabled();
});
