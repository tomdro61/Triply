import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/server";
import { stripe } from "@/lib/stripe/client";
import { reslab } from "@/lib/reslab/client";
import { resolveAirportCode } from "@/lib/attribution/airport";
import { captureAPIError } from "@/lib/sentry";
import {
  assertWaitlistSigningSecret,
  isWaitlistConfigError,
} from "@/lib/waitlist/unsubscribe-token";
import { recoveryUnsubscribeUrl } from "@/lib/checkout-recovery/unsubscribe-token";
import {
  RECOVERY_MAX_AGE_MS,
  selectRecoveryCandidates,
  type PaymentIntentLike,
  type RecoveryCandidate,
} from "@/lib/checkout-recovery/select";
import {
  isTransientSendFailure,
  sendRecoveryEmail,
  type RecoveryLotInfo,
} from "@/lib/checkout-recovery/email";

/**
 * GET /api/cron/checkout-recovery
 *
 * Every 15 minutes (vercel.json): one "you didn't finish booking" email to a
 * customer who reached the payment step 45 min – 24 h ago and never got a card
 * through, when
 *   - the check-in has not passed (see select.ts),
 *   - the same lowercased address has not paid / booked since,
 *   - the address has not opted out (this email, the newsletter, or the
 *     waitlist), and
 *   - the address has not had a recovery email in the last 7 days.
 *
 * DATA SOURCE: Stripe PaymentIntents, not pending_bookings. pending_bookings
 * is staged only when Pay Now is clicked, so the customer who never clicked it
 * — the case this exists for — has no row; the PaymentIntent created at the
 * payment step (POST /api/checkout/lot) is the only durable record.
 *
 * IDEMPOTENCY: a checkout_recovery_emails row is INSERTed (UNIQUE on the
 * PaymentIntent) BEFORE the send. A retried or overlapping run hits 23505 and
 * skips. Failure modes all err toward NOT emailing: a crash after the claim
 * leaves the row and no email.
 *
 * Gated by CHECKOUT_RECOVERY_EMAILS_ENABLED=true so the code can merge dark.
 * Auth: Vercel injects `Authorization: Bearer <CRON_SECRET>`; refuse without it.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Bounded per run; a 15-minute cadence drains any backlog quickly. */
const MAX_SENDS_PER_RUN = 25;
/** Checked between candidates (mirrors waitlist-notify's 45s/60s). */
const RUN_BUDGET_MS = 45_000;
/** At most one recovery email per address in this window. */
export const PER_EMAIL_CAP_MS = 7 * 24 * 60 * 60_000;

const CTX = { endpoint: "/api/cron/checkout-recovery", method: "GET" as const };

type Supabase = Awaited<ReturnType<typeof createAdminClient>>;

function alarm(fingerprint: string, message: string, level: "info" | "warning" | "error") {
  Sentry.withScope((scope) => {
    scope.setFingerprint([fingerprint]);
    Sentry.captureMessage(message, level);
  });
}

function fail(stage: string, message: string) {
  captureAPIError(new Error(`checkout-recovery: ${message}`), { ...CTX, stage });
  return NextResponse.json({ ok: false, error: message }, { status: 500 });
}

/** Lot name + airport for the email. One ResLab call per email actually sent.
 *  A failure here degrades the COPY ("the parking you picked"), never the
 *  send — and is reported, not swallowed. */
async function lookupLot(locationId: number): Promise<RecoveryLotInfo> {
  try {
    const loc = await reslab.getLocation(locationId);
    return {
      name: loc.name?.trim() || null,
      airportCode: resolveAirportCode({ lat: loc.latitude, lng: loc.longitude }),
    };
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      ...CTX,
      stage: "lot_lookup",
      extra: { locationId },
    });
    return { name: null, airportCode: null };
  }
}

/** Emails (lowercased) that must not be emailed: opted out of this email, the
 *  newsletter, or the waitlist. Throws on any read error — an unreadable
 *  opt-out list means we cannot honour it, so nobody gets emailed this run. */
async function suppressedEmails(supabase: Supabase, emails: string[]): Promise<Set<string>> {
  const out = new Set<string>();

  const optouts = await supabase
    .from("checkout_recovery_optouts")
    .select("email")
    .in("email", emails);
  if (optouts.error) throw new Error(`optouts read failed: ${optouts.error.message}`);
  for (const r of (optouts.data ?? []) as Array<{ email: string }>) out.add(r.email.toLowerCase());

  for (const table of ["newsletter_subscribers", "booking_waitlist"] as const) {
    const res = await supabase.from(table).select("email, unsubscribed_at").in("email", emails);
    if (res.error) throw new Error(`${table} read failed: ${res.error.message}`);
    for (const r of (res.data ?? []) as Array<{ email: string; unsubscribed_at: string | null }>) {
      if (r.unsubscribed_at) out.add(r.email.toLowerCase());
    }
  }
  return out;
}

/** Emails that completed a booking at/after their abandoned checkout. Catches
 *  a PaymentIntent created BEFORE the abandoned one but paid after (two tabs),
 *  which the Stripe-side check in select.ts cannot see. */
async function bookedSince(
  supabase: Supabase,
  candidates: RecoveryCandidate[]
): Promise<Set<string>> {
  const earliest = Math.min(...candidates.map((c) => c.createdMs));
  const { data, error } = await supabase
    .from("bookings")
    .select("created_at, customers!inner(email)")
    .gte("created_at", new Date(earliest).toISOString());
  if (error) throw new Error(`bookings read failed: ${error.message}`);

  const latestBooking = new Map<string, number>();
  for (const r of data ?? []) {
    // PostgREST returns the many-to-one embed as an object; the untyped
    // client infers an array. Accept both rather than cast.
    const cust = Array.isArray(r.customers) ? r.customers[0] : r.customers;
    const rawEmail: unknown = cust?.email;
    if (typeof rawEmail !== "string" || !rawEmail.trim()) continue;
    const email = rawEmail.trim().toLowerCase();
    const at = Date.parse(String(r.created_at));
    if ((latestBooking.get(email) ?? 0) < at) latestBooking.set(email, at);
  }
  const out = new Set<string>();
  for (const c of candidates) {
    const at = latestBooking.get(c.email);
    if (at !== undefined && at >= c.createdMs) out.add(c.email);
  }
  return out;
}

/** Emails that already got (or are being sent) a recovery email within the
 *  7-day cap, in THIS Stripe mode (staging shares the DB). */
async function recentlyEmailed(
  supabase: Supabase,
  emails: string[],
  livemode: boolean,
  nowMs: number
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("checkout_recovery_emails")
    .select("email")
    .in("email", emails)
    .eq("livemode", livemode)
    .gte("created_at", new Date(nowMs - PER_EMAIL_CAP_MS).toISOString());
  if (error) throw new Error(`send ledger read failed: ${error.message}`);
  return new Set(((data ?? []) as Array<{ email: string }>).map((r) => r.email));
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (process.env.CHECKOUT_RECOVERY_EMAILS_ENABLED !== "true") {
    return NextResponse.json({ ok: true, disabled: true });
  }

  // Every email carries an unsubscribe link; without the secret none can be
  // built. Refuse up front (503) rather than claim rows that can never send.
  try {
    assertWaitlistSigningSecret();
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      ...CTX,
      stage: "config",
    });
    return NextResponse.json(
      { ok: false, error: "signing secret is not configured" },
      { status: 503 }
    );
  }

  const nowMs = Date.now();
  const startedAt = nowMs;

  // 1) Every PaymentIntent created in the last 24 h (auto-paginates; a few
  //    dozen a day). Paid ones are needed too — they are the "paid since" check.
  const pis: PaymentIntentLike[] = [];
  try {
    for await (const pi of stripe.paymentIntents.list({
      created: { gte: Math.floor((nowMs - RECOVERY_MAX_AGE_MS) / 1000) },
      limit: 100,
    })) {
      pis.push(pi);
    }
  } catch (error) {
    return fail("stripe_list", `Stripe PaymentIntent list failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const { candidates: selected, skipped } = selectRecoveryCandidates(pis, nowMs);
  if (selected.length === 0) {
    return NextResponse.json({ ok: true, scanned: pis.length, candidates: 0, sent: 0, skipped });
  }

  const supabase = await createAdminClient();
  const emails = [...new Set(selected.map((c) => c.email))];

  // 2) Exclusions that need the database. Any read failure fails the run
  //    CLOSED — sending past an unreadable opt-out list is the one mistake
  //    this cron must not make.
  let suppressed: Set<string>;
  let booked: Set<string>;
  let capped: Set<string>;
  try {
    suppressed = await suppressedEmails(supabase, emails);
    booked = await bookedSince(supabase, selected);
    // Every PaymentIntent in one list call comes from the same Stripe key.
    capped = await recentlyEmailed(supabase, emails, selected[0].livemode, nowMs);
  } catch (error) {
    return fail("exclusions", error instanceof Error ? error.message : String(error));
  }

  const toSend = selected.filter(
    (c) => !suppressed.has(c.email) && !booked.has(c.email) && !capped.has(c.email)
  );

  const result = {
    scanned: pis.length,
    candidates: selected.length,
    suppressed: selected.filter((c) => suppressed.has(c.email)).length,
    bookedSince: selected.filter((c) => booked.has(c.email)).length,
    cappedWithin7d: selected.filter((c) => capped.has(c.email)).length,
    sent: 0,
    alreadyClaimed: 0,
    claimFailed: 0,
    sendFailed: 0,
    markFailed: 0,
    deferredToNextRun: 0,
  };

  let attempted = 0;
  for (const c of toSend) {
    if (attempted >= MAX_SENDS_PER_RUN || Date.now() - startedAt > RUN_BUDGET_MS) {
      result.deferredToNextRun++;
      continue;
    }

    // 3) Claim BEFORE sending. UNIQUE(stripe_payment_intent_id) is the lock.
    const claim = await supabase
      .from("checkout_recovery_emails")
      .insert({
        stripe_payment_intent_id: c.paymentIntentId,
        email: c.email,
        livemode: c.livemode,
        status: "claimed",
      })
      .select("id")
      .single();
    if (claim.error) {
      if (claim.error.code === "23505") {
        result.alreadyClaimed++;
      } else {
        result.claimFailed++;
        captureAPIError(new Error(`checkout-recovery claim failed: ${claim.error.message}`), {
          ...CTX,
          stage: "claim",
          code: claim.error.code,
        });
      }
      continue;
    }
    const rowId = (claim.data as { id: string }).id;
    attempted++;

    try {
      const lot = await lookupLot(c.locationId);
      await sendRecoveryEmail(c, lot, recoveryUnsubscribeUrl(rowId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      captureAPIError(error instanceof Error ? error : new Error(message), { ...CTX, stage: "send" });
      result.sendFailed++;
      if (isWaitlistConfigError(error)) {
        // Env changed under a running instance — not this row's fault.
        await releaseClaim(supabase, rowId);
        break;
      }
      if (isTransientSendFailure(error)) {
        // Release so the next tick retries while the checkout is still fresh.
        await releaseClaim(supabase, rowId);
      } else {
        // Permanent (bad / suppressed address): keep the row so it never retries.
        const { error: markErr } = await supabase
          .from("checkout_recovery_emails")
          .update({ status: "failed", last_error: message.slice(0, 500) })
          .eq("id", rowId);
        if (markErr) {
          captureAPIError(new Error(markErr.message), { ...CTX, stage: "mark_failed" });
        }
      }
      continue;
    }

    // The email is out. A failed status write leaves the row `claimed`, which
    // still blocks any resend — bookkeeping only, but reported.
    const { data: marked, error: markErr } = await supabase
      .from("checkout_recovery_emails")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", rowId)
      .select("id");
    if (markErr || !Array.isArray(marked) || marked.length === 0) {
      result.markFailed++;
      captureAPIError(
        new Error(`checkout-recovery: sent but status not recorded for ${rowId}: ${markErr?.message ?? "matched no rows"}`),
        { ...CTX, stage: "mark_sent" }
      );
    }
    result.sent++;
  }

  if (result.deferredToNextRun > 0) {
    alarm(
      "checkout_recovery_capped",
      `checkout-recovery: ${result.deferredToNextRun} candidate(s) deferred to the next run (cap ${MAX_SENDS_PER_RUN} / ${RUN_BUDGET_MS}ms budget)`,
      "warning"
    );
  }

  // Nothing went out although we tried: an outage or a broken write path.
  // Loud, non-2xx, so Vercel's cron alerting sees it.
  const allFailed = attempted + result.claimFailed > 0 && result.sent === 0;
  if (result.sendFailed + result.claimFailed + result.markFailed > 0) {
    alarm(
      "checkout_recovery_failures",
      `checkout-recovery: ${result.sendFailed} send / ${result.claimFailed} claim / ${result.markFailed} mark failure(s); ${result.sent} sent`,
      allFailed ? "error" : "warning"
    );
    await Sentry.flush(2000).catch(() => {});
  }

  return NextResponse.json(
    { ok: !allFailed, ...result, skipped },
    { status: allFailed ? 500 : 200 }
  );
}

/** Delete a claim so the checkout can be retried. A failed delete leaves the
 *  row `claimed` — no retry, no duplicate — and is reported. */
async function releaseClaim(supabase: Supabase, rowId: string) {
  const { error } = await supabase.from("checkout_recovery_emails").delete().eq("id", rowId);
  if (error) {
    captureAPIError(new Error(`checkout-recovery: could not release claim ${rowId}: ${error.message}`), {
      ...CTX,
      stage: "release_claim",
    });
  }
}
