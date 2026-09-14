/**
 * Park Guard plan tiers — the pure, environment-free half of the PG module.
 *
 * Everything here is safe to import from "use client" components, the Zod
 * schemas, and tests: no env reads, no fetch, no side effects. The HTTP client
 * (./client.ts) re-exports all of it, so server code can keep a single import.
 *
 * Compliance (Park Guard Marketing Guidelines PDF, "Words to Avoid" — kept in
 * the gitignored `parkguard/` folder; ask Tom for a copy): nothing that renders
 * to a customer may say "insurance", "coverage", "supplemental" or "settlement".
 * "Covers up to $X of theft and damages" is the verb form PG's own FAQ template
 * uses ("covers physical damages"); only the noun "coverage" is on the list.
 */

/**
 * The sellable tiers. Single source of truth: the TS type, the Zod wire schema
 * (`protectionPlanCodeSchema`), the checkout selector and the copy below all
 * derive from this tuple. The one boundary the compiler cannot reach is the SQL
 * `CHECK (protection_plan_code IN ('A','B','C'))` in migration 021 — update it
 * by hand if a tier is ever added.
 */
export const PROTECTION_PLAN_CODES = ["A", "B", "C"] as const;
export type ProtectionPlanCode = (typeof PROTECTION_PLAN_CODES)[number];

/**
 * What the checkout selector holds once the customer has decided: a tier, or an
 * explicit "none". `null` (undecided) lives only in component state and never
 * reaches the wire — API payloads carry a code or null (see
 * `protectionChoiceToCode`).
 */
export type ProtectionChoice = ProtectionPlanCode | "none";

export interface ProtectionPlanTier {
  readonly code: ProtectionPlanCode;
  /**
   * Code sent to Park Guard in the capture payload's `protection_plan` field.
   * Contractual — must match a plan configured on PG's side for TriplyPro.
   */
  readonly pgPlanCode: `Plan ${ProtectionPlanCode}`;
  /** Short label on the checkout selector card ("Plan A"). Customer-visible. */
  readonly label: `Plan ${ProtectionPlanCode}`;
  /**
   * Display name stored in `bookings.protection_plan` and rendered on the
   * confirmation page + emails ("$500 Protection"). Customer-visible. NOT sent
   * to Park Guard.
   */
  readonly name: string;
  /**
   * CURRENT retail premium charged at checkout, in dollars. What a given
   * booking actually paid is read from its PaymentIntent and stored in
   * `bookings.protection_plan_price` — never this constant — so a retail change
   * never rewrites history or blocks an in-flight booking.
   */
  readonly price: number;
  /**
   * What Park Guard bills Triply per opt-in on this tier, in dollars. Sourced
   * from the IE Holdings × Park Guard contract — verify before changing.
   * Snapshotted per row into `bookings.protection_plan_wholesale` at
   * fulfilment, so cancel refunds and accounting read what applied at capture
   * time, never this live constant.
   */
  readonly wholesalePrice: number;
  /** Damage/theft limit — copy and records. */
  readonly limitDollars: number;
}

/** Pins key ↔ code ↔ PG code ↔ label at compile time. */
type TierTable = {
  readonly [K in ProtectionPlanCode]: ProtectionPlanTier & {
    readonly code: K;
    readonly pgPlanCode: `Plan ${K}`;
    readonly label: `Plan ${K}`;
  };
};

/**
 * Retail + wholesale locked with Tom on 2026-09-14. Plan A history: $9.99 at
 * launch (2026-05-13) → $12.99 → $10.99 (2026-05-28, for conversion) → back to
 * $12.99 once the cheaper tiers existed to absorb price-sensitive buyers.
 */
export const PROTECTION_PLANS: TierTable = {
  A: {
    code: "A",
    pgPlanCode: "Plan A",
    label: "Plan A",
    name: "$1,000 Protection",
    price: 12.99,
    wholesalePrice: 6.0,
    limitDollars: 1000,
  },
  B: {
    code: "B",
    pgPlanCode: "Plan B",
    label: "Plan B",
    name: "$500 Protection",
    price: 7.99,
    wholesalePrice: 4.0,
    limitDollars: 500,
  },
  C: {
    code: "C",
    pgPlanCode: "Plan C",
    label: "Plan C",
    name: "$250 Protection",
    price: 4.95,
    wholesalePrice: 2.0,
    limitDollars: 250,
  },
};

export function isProtectionPlanCode(value: unknown): value is ProtectionPlanCode {
  return (
    typeof value === "string" &&
    (PROTECTION_PLAN_CODES as readonly string[]).includes(value)
  );
}

/** Tier for a code; null for "no protection". `undefined` is deliberately not
 *  accepted — a caller that forgot the field must fail to compile, not book
 *  "declined". */
export function getProtectionPlan(
  code: ProtectionPlanCode | null
): ProtectionPlanTier | null {
  return code === null ? null : PROTECTION_PLANS[code];
}

/**
 * Selector state → wire value. "none" → null, a tier code → itself. The
 * explicit-decline vs undecided distinction stays in the component; the API
 * boundary only ever sees code-or-null.
 */
export function protectionChoiceToCode(
  choice: ProtectionChoice
): ProtectionPlanCode | null {
  return choice === "none" ? null : choice;
}

/** "$1,000" — locale pinned so a de-DE browser doesn't render "1.000". */
export function formatLimit(limitDollars: number): string {
  return `$${limitDollars.toLocaleString("en-US")}`;
}

// -----------------------------------------------------------------------------
// PaymentIntent metadata — the server-trusted record of what the customer is
// paying for. Written by /api/checkout/lot and /api/checkout/lot/update-pi as a
// PAIR (`protectionPlanCode` + `protectionPlanPrice`, both present or both
// absent); read by /api/reservations/pending (to stage the tier) and by
// fulfilment (to book, price, and enrol exactly what was charged).
// -----------------------------------------------------------------------------

/** Premium in integer cents for the PaymentIntent amount; 0 for no protection. */
export function protectionPremiumCents(plan: ProtectionPlanTier | null): number {
  return plan ? Math.round(plan.price * 100) : 0;
}

/**
 * The metadata pair for a tier. `null` values tell Stripe to DELETE the key,
 * so "no protection" removes both — never a half pair, never an empty-string
 * sentinel (which would make "key present" checks ambiguous downstream).
 */
export function protectionMetadataPatch(plan: ProtectionPlanTier): {
  protectionPlanCode: string;
  protectionPlanPrice: string;
};
export function protectionMetadataPatch(plan: null): {
  protectionPlanCode: null;
  protectionPlanPrice: null;
};
export function protectionMetadataPatch(plan: ProtectionPlanTier | null): {
  protectionPlanCode: string | null;
  protectionPlanPrice: string | null;
};
export function protectionMetadataPatch(plan: ProtectionPlanTier | null): {
  protectionPlanCode: string | null;
  protectionPlanPrice: string | null;
} {
  return {
    protectionPlanCode: plan ? plan.code : null,
    protectionPlanPrice: plan ? plan.price.toFixed(2) : null,
  };
}

export type MetadataProtection =
  /** Neither key present: the customer declined (or never picked). */
  | { kind: "none" }
  /** A tier and the premium that was actually charged for it. */
  | { kind: "tier"; code: ProtectionPlanCode; premium: number }
  /**
   * A price with no tier code: stamped by the pre-tier bundle (before
   * 2026-09-14), when Plan A was the only tier. Fulfilment treats it as Plan A
   * at the charged premium; the pending route refuses it (a new bundle can't
   * produce it).
   */
  | { kind: "legacy_plan_a"; premium: number }
  /** A half pair, an unknown code, or a non-positive price. Never guess. */
  | { kind: "invalid"; detail: string };

export function readProtectionMetadata(
  meta: Record<string, string | undefined> | null | undefined
): MetadataProtection {
  const rawCode = meta?.protectionPlanCode;
  const rawPrice = meta?.protectionPlanPrice;
  const hasCode = rawCode !== undefined && rawCode !== "";
  const hasPrice = rawPrice !== undefined && rawPrice !== "";
  if (!hasCode && !hasPrice) return { kind: "none" };

  const premium = hasPrice ? parseFloat(rawPrice) : Number.NaN;
  const priceOk = Number.isFinite(premium) && premium > 0;

  if (hasCode && !isProtectionPlanCode(rawCode)) {
    return { kind: "invalid", detail: `unknown protectionPlanCode ${JSON.stringify(rawCode)}` };
  }
  if (!priceOk) {
    return {
      kind: "invalid",
      detail: `protectionPlanPrice ${JSON.stringify(rawPrice)} is not a positive number` +
        (hasCode ? ` (protectionPlanCode=${rawCode})` : ""),
    };
  }
  if (!hasCode) return { kind: "legacy_plan_a", premium };
  return { kind: "tier", code: rawCode, premium };
}

/** Shown when a checkout page loaded before the plan-tier deploy posts the old
 *  boolean (`hasProtectionPlan`). Its request can't be honoured; tell the
 *  customer what to do instead of a Zod message they can't act on. */
export const STALE_CHECKOUT_MESSAGE =
  "This page is out of date — please refresh to continue. You have not been charged.";

// -----------------------------------------------------------------------------
// Customer-facing copy derived from the plan map. Consumers: Help FAQ
// (src/app/(main)/help/page.tsx), Terms §5.2 (terms/page.tsx), the AI knowledge
// base (src/lib/ai/knowledge-base.ts), the self-cancel dialog fallback
// (src/components/reservations/cancel-reservation-button.tsx), and admin
// tooltips. Kept here so a price change can't leave stale numbers on a page.
// -----------------------------------------------------------------------------

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** "a, b, or c" / "a, b, and c" — one join, no conjunction smuggled into items. */
function joinList(parts: readonly string[], conjunction: "or" | "and"): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")}, ${conjunction} ${parts[parts.length - 1]}`;
}

const TIERS: readonly ProtectionPlanTier[] = PROTECTION_PLAN_CODES.map(
  (code) => PROTECTION_PLANS[code]
);

/** "up to $1,000 of protection for $12.99, up to $500 for $7.99, or up to $250 for $4.95 per trip" */
export const PG_TIER_SUMMARY =
  joinList(
    TIERS.map((p, i) =>
      i === 0
        ? `up to ${formatLimit(p.limitDollars)} of protection for ${usd(p.price)}`
        : `up to ${formatLimit(p.limitDollars)} for ${usd(p.price)}`
    ),
    "or"
  ) + " per trip";

/** "$1,000, $500, or $250" */
export const PG_LIMIT_SUMMARY = joinList(
  TIERS.map((p) => formatLimit(p.limitDollars)),
  "or"
);

/** "$6.00 for the $1,000 plan, $4.00 for the $500 plan, and $2.00 for the $250 plan" —
 *  the non-refundable portion of the premium on a cancellation (the PG wholesale). */
export const PG_NONREFUNDABLE_SUMMARY = joinList(
  TIERS.map((p) => `${usd(p.wholesalePrice)} for the ${formatLimit(p.limitDollars)} plan`),
  "and"
);

/** "$6.00 / $4.00 / $2.00" — admin-only tooltips. */
export const PG_WHOLESALE_SHORT_SUMMARY = TIERS.map((p) => usd(p.wholesalePrice)).join(" / ");
