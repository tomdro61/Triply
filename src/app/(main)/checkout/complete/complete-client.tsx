"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { markPurchaseToTrack } from "@/lib/analytics/purchase-once";
import { captureBookingError } from "@/lib/sentry";
import {
  clearRecoveryMarker,
  readRecoveryMarker,
  saveRecoveryMarker,
} from "@/lib/checkout/recovery-marker";

/** Poll cadence and ceiling. The webhook normally completes a booking within a
 *  couple of seconds; the ceiling exists so a customer never watches an infinite
 *  spinner — they get a real message and a way to reach us. */
const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 45; // ~90 seconds

/** What the card holds while the booking is unresolved — from Stripe's own
 *  figures via /api/reservations/complete, never computed here. */
interface MoneyOnCard {
  amountCents: number;
  currency: string;
  charge: "hold" | "captured";
}

type ViewState =
  | { kind: "working" }
  | { kind: "failed"; message: string }
  | { kind: "payment_failed"; message: string }
  | { kind: "needs_support"; message: string; reference: string | null; money: MoneyOnCard | null }
  | { kind: "timeout"; reference: string | null };

function moneyFromAnswer(data: Record<string, unknown>): MoneyOnCard | null {
  const amountCents = data.amountCents;
  const currency = data.currency;
  const charge = data.charge;
  if (
    typeof amountCents === "number" &&
    Number.isFinite(amountCents) &&
    amountCents > 0 &&
    typeof currency === "string" &&
    (charge === "hold" || charge === "captured")
  ) {
    return { amountCents, currency, charge };
  }
  return null;
}

function formatMoney(money: MoneyOnCard): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: money.currency.toUpperCase() }).format(
      money.amountCents / 100
    );
  } catch {
    return `${(money.amountCents / 100).toFixed(2)} ${money.currency.toUpperCase()}`;
  }
}

export default function CheckoutCompleteClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [view, setView] = useState<ViewState>({ kind: "working" });
  // Guards against React 18 StrictMode double-invocation and any re-render
  // restarting the poll loop mid-flight.
  const startedRef = useRef(false);
  // Set false on unmount. Checked before every state write / navigation so a
  // poll that resolves after the customer navigated away (Back button) can't
  // yank them back with router.replace or setState on an unmounted component.
  const mountedRef = useRef(true);

  // Stripe appends BOTH of these to return_url. The client secret is the
  // credential the completion endpoint authenticates against. This page scrubs
  // them from the address bar on mount, so a refresh arrives with neither —
  // the per-tab marker (saved below, and by checkout at the hand-off) is how
  // the same payment is resumed instead of telling a customer with a live
  // hold that we couldn't identify it.
  const [resolved] = useState(() => {
    const fromUrl = {
      paymentIntentId: searchParams.get("payment_intent"),
      clientSecret: searchParams.get("payment_intent_client_secret"),
    };
    if (fromUrl.paymentIntentId && fromUrl.clientSecret) return fromUrl;
    const marker = readRecoveryMarker();
    return marker
      ? { paymentIntentId: marker.paymentIntentId, clientSecret: marker.clientSecret }
      : fromUrl;
  });
  const { paymentIntentId, clientSecret } = resolved;

  const poll = useCallback(async () => {
    if (!paymentIntentId || !clientSecret) {
      setView({
        kind: "failed",
        message:
          "We couldn't identify this payment. If you were charged, contact support@triplypro.com and we'll sort it out straight away.",
      });
      return;
    }

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (!mountedRef.current) return; // customer navigated away — stop.
      try {
        const res = await fetch("/api/reservations/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paymentIntentId, clientSecret }),
        });

        if (!mountedRef.current) return;

        if (res.status === 404) {
          setView({
            kind: "failed",
            message:
              "We couldn't verify this payment. If you were charged, contact support@triplypro.com and we'll sort it out straight away.",
          });
          return;
        }

        const data = await res.json();
        if (!mountedRef.current) return;

        switch (data.state) {
          case "booked":
            clearRecoveryMarker();
            // The confirmation page sends the GA4 purchase only for this mark.
            if (typeof data.reservationNumber === "string") {
              markPurchaseToTrack(data.reservationNumber);
            } else {
              // Still navigate; but every 3-D Secure purchase would go
              // unreported, so make the contract drift visible.
              captureBookingError(
                new Error("checkout/complete: booked without reservationNumber; GA4 purchase not marked"),
                { step: "confirmation", fingerprint: ["complete-booked-no-reservation-number"] }
              );
            }
            router.replace(data.confirmationUrl);
            return;
          case "payment_failed":
          case "payment_incomplete":
            clearRecoveryMarker();
            setView({ kind: "payment_failed", message: data.message });
            return;
          case "failed":
            clearRecoveryMarker();
            setView({ kind: "failed", message: data.message });
            return;
          case "needs_support":
            // The marker is KEPT: a refresh must show this same state again.
            setView({
              kind: "needs_support",
              message: data.message,
              reference: typeof data.reference === "string" ? data.reference : paymentIntentId,
              money: moneyFromAnswer(data),
            });
            return;
          case "pending":
          default:
            break; // keep polling
        }
      } catch {
        // Network blip — keep polling. The customer has paid; giving up here
        // would show a failure for a booking that is very likely succeeding.
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (mountedRef.current) setView({ kind: "timeout", reference: paymentIntentId });
  }, [paymentIntentId, clientSecret, router]);

  useEffect(() => {
    // Re-arm on every mount so React 18 StrictMode's mount→unmount→remount in
    // dev doesn't leave mountedRef stuck false (the cleanup from the first mount
    // sets it false; without this the remount's poll would see false and stop).
    mountedRef.current = true;
    if (startedRef.current) return;
    startedRef.current = true;

    // Remember the payment for this tab BEFORE scrubbing the URL, so a refresh
    // resumes it (cleared on every answer that releases the hold or confirms).
    if (paymentIntentId && clientSecret) {
      saveRecoveryMarker({ paymentIntentId, clientSecret });
    }
    // Scrub the client secret out of the address bar so it isn't left in
    // history, screenshots, or a copied URL.
    if (typeof window !== "undefined" && window.location.search) {
      window.history.replaceState({}, "", "/checkout/complete");
    }

    void poll();
    return () => {
      mountedRef.current = false;
    };
  }, [poll, paymentIntentId, clientSecret]);

  if (view.kind === "working") {
    return (
      <Shell>
        <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-[#f87356]" />
        <h1 className="mt-6 font-[Poppins] text-2xl font-bold text-[#1A1A2E]">
          Confirming your booking
        </h1>
        <p className="mt-3 text-slate-600">
          Your payment went through. We're securing your parking spot now — this
          usually takes a few seconds.
        </p>
        <p className="mt-6 text-sm text-slate-500">
          Please don't close this page or press back.
        </p>
      </Shell>
    );
  }

  if (view.kind === "payment_failed") {
    return (
      <Shell>
        <StatusIcon tone="neutral" />
        <h1 className="mt-6 font-[Poppins] text-2xl font-bold text-[#1A1A2E]">
          Payment wasn't completed
        </h1>
        <p className="mt-3 text-slate-600">{view.message}</p>
        <Link
          href="/"
          className="mt-8 inline-block rounded-lg bg-[#f87356] px-6 py-3 font-semibold text-white transition hover:opacity-90"
        >
          Start a new search
        </Link>
      </Shell>
    );
  }

  if (view.kind === "failed") {
    return (
      <Shell>
        <StatusIcon tone="warning" />
        <h1 className="mt-6 font-[Poppins] text-2xl font-bold text-[#1A1A2E]">
          We couldn't complete this booking
        </h1>
        <p className="mt-3 text-slate-600">{view.message}</p>
        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <Link
            href="/"
            className="rounded-lg bg-[#f87356] px-6 py-3 font-semibold text-white transition hover:opacity-90"
          >
            Start a new search
          </Link>
          <Link
            href="/contact"
            className="rounded-lg border border-slate-300 px-6 py-3 font-semibold text-[#1A1A2E] transition hover:bg-slate-50"
          >
            Contact support
          </Link>
        </div>
      </Shell>
    );
  }

  // needs_support and timeout both mean: money is in flight and we will not
  // claim otherwise. Never tell this customer they weren't charged — and never
  // promise they can't be charged twice: booking again WOULD create a second
  // hold. The amount shown is Stripe's own figure for this PaymentIntent.
  const isTimeout = view.kind === "timeout";
  const money = view.kind === "needs_support" ? view.money : null;
  const reference = view.reference;
  return (
    <Shell>
      <StatusIcon tone="warning" />
      <h1 className="mt-6 font-[Poppins] text-2xl font-bold text-[#1A1A2E]">
        We&apos;re finishing your booking
      </h1>
      <p className="mt-3 text-slate-600">
        {isTimeout
          ? "This is taking longer than usual. Your payment is being handled and our team has been alerted — we'll email you a confirmation shortly."
          : view.message}
      </p>
      <p className="mt-3 text-slate-600" data-testid="money-on-card">
        {money
          ? money.charge === "hold"
            ? `The ${formatMoney(money)} on your card is a hold, not a final charge. It is only taken once your reservation is confirmed; otherwise it is released.`
            : `Your card was charged ${formatMoney(money)}. If we can't confirm this reservation, that amount is refunded in full.`
          : "The amount on your card is not final until your reservation is confirmed. If we can't confirm it, it is released or refunded in full."}
      </p>
      <p className="mt-4 font-semibold text-slate-700">
        Please don&apos;t book again — a second booking would place a second charge on your card.
      </p>
      {reference && (
        <p className="mt-4 text-sm text-slate-500">
          Your reference: <span className="font-mono text-slate-700 break-all">{reference}</span>
          <br />
          Quote it if you contact us.
        </p>
      )}
      <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
        <Link
          href="/contact"
          className="rounded-lg bg-[#f87356] px-6 py-3 font-semibold text-white transition hover:opacity-90"
        >
          Contact support
        </Link>
        <a
          href="mailto:support@triplypro.com"
          className="rounded-lg border border-slate-300 px-6 py-3 font-semibold text-[#1A1A2E] transition hover:bg-slate-50"
        >
          support@triplypro.com
        </a>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        {children}
      </div>
    </div>
  );
}

function StatusIcon({ tone }: { tone: "neutral" | "warning" }) {
  const color = tone === "warning" ? "#f87356" : "#64748b";
  return (
    <div
      className="mx-auto flex h-12 w-12 items-center justify-center rounded-full"
      style={{ backgroundColor: `${color}1a` }}
      aria-hidden="true"
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6" />
        <path d="M12 16.5v.01" />
      </svg>
    </div>
  );
}
