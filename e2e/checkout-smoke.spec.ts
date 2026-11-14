/**
 * Checkout smoke test: runs on a PR's own preview and STOPS BEFORE PAY.
 *
 * What it proves: the preview is up, checkout loads a lot and a price, both
 * form steps advance, the server creates a PaymentIntent, Stripe's form
 * mounts, and the amount on the pay button equals what the server computed
 * and what Stripe holds, before and after a protection plan is picked.
 *
 * What it never does: type a card or click Pay. lib/guard.ts aborts, and
 * fails the run on, any write request it does not list, /api/search,
 * /api/reservations*, /checkout/complete and a Stripe confirm; do not loosen
 * it to make a test pass. What the allowed requests do on the server is
 * checked by src/app/api/checkout/__tests__/pre-pay-no-writes.test.ts.
 *
 * Not covered (still the manual `/verify-flow checkout` walk): authorization,
 * the reservation, capture, the confirmation page, emails, wallets.
 */
import { test as base, expect, errors, type Page, type Response } from "@playwright/test";
import { installGuard, type Guard } from "./lib/guard";
import { failure, previewOrigin, previewToken, TRUSTED_TOKEN_HEADER } from "./lib/preview-access";

let access: Promise<void> | undefined;
/** Asked once, from Node, before any test touches the browser: a refused
 *  credential fails EVERY test as CONFIG, not as a broken page. */
function assertPreviewAccess(): Promise<void> {
  access ??= (async () => {
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
    if (probe.status !== 200) throw failure("APP", `/terms returned HTTP ${probe.status} on the preview`);
  })();
  return access;
}

/** Response.json() is typed `any`: take it as `unknown` and read one path. */
function at(body: unknown, ...path: string[]): unknown {
  let value = body;
  for (const key of path) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return undefined;
    value = Object.getOwnPropertyDescriptor(value, key)?.value;
  }
  return value;
}
function num(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw failure("APP", `${what} is not a number`);
  return value;
}
function str(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw failure("APP", `${what} is not a string`);
  return value;
}

/**
 * Wait for the page's own call to one of our API routes, and say WHY when it
 * does not arrive. Only "the request was sent and the server was still
 * working at the deadline" is UPSTREAM: a page that never asks is our bug,
 * and UPSTREAM is the one label a retry is allowed to clear.
 */
function apiResponse(page: Page, guard: Guard, method: "GET" | "POST", pathname: string, what: string): Promise<Response> {
  let sent = false;
  const matches = (candidate: { method(): string; url(): string }) =>
    candidate.method() === method && new URL(candidate.url()).pathname === pathname;
  page.on("request", (request) => {
    if (matches(request)) sent = true;
  });
  return page
    .waitForResponse((response) => matches(response.request()), { timeout: 60_000 })
    .catch((error: unknown) => {
      if (!(error instanceof errors.TimeoutError)) throw error;
      if (!sent) throw failure("APP", `the page never asked for ${what} (${method} ${pathname})`);
      const cut = guard.fetchFailure(pathname);
      if (cut === "network") throw failure("UPSTREAM", `the connection to the preview failed while ${what}`);
      throw failure(
        "UPSTREAM",
        `${what} did not finish within 60 s (a slow staging ResLab is the usual cause; if it keeps failing, read the preview's logs)`
      );
    });
}

/** ResLab TEST lot (src/config/admin.ts). Loads on previews, refused in production. */
const TEST_LOT = "reslab-194";

const test = base.extend<{ guard: Guard }>({
  // Every test gets the guard before its first navigation, and fails on a violation.
  guard: [
    async ({ context }, provide) => {
      await assertPreviewAccess();
      const guard = await installGuard(context, previewOrigin());
      await provide(guard);
      await guard.close();
      // A redirect the guard refused: a failure with its own label, so the
      // retry and labelling rules apply to it.
      if (guard.problems.length > 0) throw new Error(guard.problems[0]);
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

/** The dollar amount on the pay button, in cents; null while it shows no amount ("Updating total…"). */
async function payButtonCents(page: Page): Promise<number | null> {
  const labels = await page.getByRole("button", { name: /(Pay Now|Complete Booking) - \$/ }).allTextContents();
  const match = /\$([\d,]+\.\d{2})/.exec(labels[0] ?? "");
  return match ? cents(Number(match[1].replace(/,/g, ""))) : null;
}

/** What Stripe itself holds for the PaymentIntent, read with the page's own publishable (test) key. */
async function stripeHolds(
  publishableKey: string,
  paymentIntentId: string,
  clientSecret: string
): Promise<{ amountCents: number; status: string }> {
  const response = await fetch(
    `https://api.stripe.com/v1/payment_intents/${paymentIntentId}?client_secret=${encodeURIComponent(clientSecret)}`,
    { headers: { authorization: `Bearer ${publishableKey}` } }
  );
  if (response.status >= 500 || response.status === 429) {
    throw failure("UPSTREAM", `Stripe returned HTTP ${response.status} for the PaymentIntent`);
  }
  if (!response.ok) {
    throw failure(
      "APP",
      `Stripe refused the PaymentIntent read (HTTP ${response.status}): wrong id or client secret, or the page's key and the server's key belong to different Stripe accounts`
    );
  }
  const body: unknown = await response.json();
  return { amountCents: num(at(body, "amount"), "Stripe's amount"), status: str(at(body, "status"), "Stripe's status") };
}

const isPost = (response: Response, pathname: string) =>
  response.request().method() === "POST" && new URL(response.url()).pathname === pathname;

test("the preview is reachable with this job's credential and serves a static page", async ({ page }) => {
  // The credential itself is checked before every test (assertPreviewAccess).
  // /terms, not the home page: the home page's featured lots call /api/search.
  const response = await page.goto("/terms");
  expect(response?.status(), "/terms loads in the browser").toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeVisible();
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
  // A cold preview renders, hydrates and asks staging ResLab (sign-in, the
  // lot, its price, its cost) inside this wait.
  const lotLoad = apiResponse(page, guard, "GET", "/api/checkout/lot", "loading the test lot");
  await page.goto(checkoutUrl(true));
  const lotResponse = await lotLoad;
  // The route answers 503 when an upstream is down and 500 for anything else.
  if ([502, 503, 504].includes(lotResponse.status())) {
    throw failure("UPSTREAM", `/api/checkout/lot returned HTTP ${lotResponse.status()} (staging ResLab or the location list is unavailable)`);
  }
  if (!lotResponse.ok()) {
    throw failure(
      "APP",
      `/api/checkout/lot returned HTTP ${lotResponse.status()} for the test lot (read the preview's logs; a ResLab sign-in failure, or the lot missing from staging ResLab, also lands here)`
    );
  }
  const lotData: unknown = await lotResponse.json();
  // Also proves this is a preview: production refuses the test lots.
  expect(str(at(lotData, "lot", "name"), "the lot's name"), "the test lot's name starts with TEST").toMatch(/^TEST/i);
  if (at(lotData, "costData", "soldOut") === true) {
    throw failure("UPSTREAM", "test lot 194 is sold out on staging ResLab for these dates");
  }
  if (typeof at(lotData, "costData", "costsToken") !== "string") {
    // The page shows an estimate when ResLab cannot price the stay: not a real quote.
    throw failure("UPSTREAM", "staging ResLab did not price the stay (the page fell back to an estimate)");
  }
  const quotedCents = cents(num(at(lotData, "costData", "dueNow"), "the quoted amount due now"));
  expect(quotedCents, "the server priced the stay").toBeGreaterThan(0);
  // How the app decides what a lot-specific field must hold: by its input type.
  const extraFieldTypes = new Map<string, string>();
  const declared = at(lotData, "lot", "extraFields");
  for (const extraField of Array.isArray(declared) ? declared : []) {
    const name = at(extraField, "name");
    const inputType = at(extraField, "inputType");
    if (typeof name === "string") extraFieldTypes.set(name, typeof inputType === "string" ? inputType : "");
  }

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
    const name = ((await extra.getAttribute("data-funnel-field")) ?? "").slice("extra:".length);
    const inputType = extraFieldTypes.get(name) ?? "";
    const isFlight = inputType === "flight_number" || name.toLowerCase().includes("flight");
    await extra.fill(isFlight ? "UA123" : inputType === "number" ? "1" : "N/A");
  }

  const intentCreated = apiResponse(page, guard, "POST", "/api/checkout/lot", "creating the PaymentIntent");
  await page.getByRole("button", { name: "Continue to Payment" }).click();
  const intentResponse = await intentCreated;
  if ([502, 503, 504].includes(intentResponse.status())) {
    throw failure("UPSTREAM", `creating the PaymentIntent returned HTTP ${intentResponse.status()} (staging ResLab or Stripe is unavailable)`);
  }
  if (intentResponse.status() === 409) {
    throw failure("UPSTREAM", "test lot 194 sold out on staging ResLab between loading and Continue to Payment");
  }
  if (!intentResponse.ok()) {
    // A 500 here is ours until shown otherwise: the route also returns it when ResLab or Stripe refuses our request.
    throw failure("APP", `creating the PaymentIntent returned HTTP ${intentResponse.status()} (read the preview's logs)`);
  }
  const intent: unknown = await intentResponse.json();
  const parkingOnlyCents = num(at(intent, "chargeCents"), "chargeCents");
  const paymentIntentId = str(at(intent, "paymentIntentId"), "paymentIntentId");
  const clientSecret = str(at(intent, "clientSecret"), "clientSecret");
  expect(Number.isInteger(parkingOnlyCents) && parkingOnlyCents > 0, "the server returned a charge in cents").toBe(true);
  expect(paymentIntentId).toMatch(/^pi_/);
  expect(parkingOnlyCents, "the charge is the amount the page quoted when it loaded").toBe(quotedCents);

  // ── 3. Stripe's form mounts; the amount agrees three ways ──────────────
  await expect(page.getByRole("heading", { name: "Payment", exact: true })).toBeVisible();
  await expect(page.locator('iframe[title="Secure payment input frame"]').first()).toBeAttached({ timeout: 30_000 });
  // Nothing is pre-selected: no amount on the button until the customer chooses.
  await expect(page.getByRole("button", { name: "Select a protection option above" })).toBeDisabled();

  const atStripe = async () => {
    await expect
      .poll(() => guard.publishableKey(), { message: "the page calls Stripe with a test publishable key" })
      .not.toBeNull();
    const key = guard.publishableKey();
    if (!key) throw failure("APP", "the page never called Stripe with a test publishable key");
    return stripeHolds(key, paymentIntentId, clientSecret);
  };
  expect((await atStripe()).amountCents, "Stripe holds what the server said it would charge").toBe(parkingOnlyCents);

  /** Pick an option; return the server's new amount once Stripe has it. */
  const choose = async (value: "A" | "B" | "C" | "none") => {
    const updated = page.waitForResponse((response) => isPost(response, "/api/checkout/lot/update-pi"), { timeout: 30_000 });
    await page.locator(`input[type="radio"][value="${value}"]`).check();
    const response = await updated;
    if (!response.ok()) throw failure("APP", `update-pi returned HTTP ${response.status()} for "${value}"`);
    const body: unknown = await response.json();
    return cents(num(at(body, "amount"), "update-pi amount"));
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
  expect((await atStripe()).amountCents, "Stripe holds the amount with the plan").toBe(withPlanCents);

  // No protection: back to the parking-only charge, everywhere.
  const withoutPlanCents = await choose("none");
  expect(withoutPlanCents, "declining the plan returns to the parking-only charge").toBe(parkingOnlyCents);
  await expect
    .poll(() => payButtonCents(page), { message: "the pay button shows the parking-only amount" })
    .toBe(parkingOnlyCents);
  expect((await atStripe()).amountCents, "Stripe holds the parking-only amount").toBe(parkingOnlyCents);

  // Pay becomes available once the terms are accepted (no card needed for that).
  // It is checked, never clicked.
  await page.locator("label", { hasText: "I agree to the" }).getByRole("checkbox").check();
  await expect(page.getByRole("button", { name: /(Pay Now|Complete Booking) - \$/ })).toBeEnabled();

  // And nothing was paid: the PaymentIntent is still waiting for a card.
  expect((await atStripe()).status, "the PaymentIntent was never confirmed").toBe("requires_payment_method");
});
