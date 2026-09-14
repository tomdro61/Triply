import { describe, it, expect } from "vitest";
import {
  PROTECTION_PLANS,
  PROTECTION_PLAN_CODES,
  PG_TIER_SUMMARY,
  PG_LIMIT_SUMMARY,
  PG_NONREFUNDABLE_SUMMARY,
  PG_WHOLESALE_SHORT_SUMMARY,
  getProtectionPlan,
  isProtectionPlanCode,
  protectionChoiceToCode,
  protectionPremiumCents,
  protectionMetadataPatch,
  readProtectionMetadata,
  formatLimit,
} from "../plans";
import { protectionPlanCodeSchema } from "@/lib/validation/schemas";

/**
 * Pins the tier table Tom locked on 2026-09-14 and the invariants every money
 * path relies on. A typo here (a negative margin, a code the wire schema
 * doesn't know) would silently misprice checkout, cancel refunds, or the
 * Park Guard capture payload.
 */
describe("PROTECTION_PLANS", () => {
  it("has exactly the three contracted tiers, keyed by their own code", () => {
    expect(PROTECTION_PLAN_CODES).toEqual(["A", "B", "C"]);
    for (const code of PROTECTION_PLAN_CODES) {
      expect(PROTECTION_PLANS[code].code).toBe(code);
      expect(PROTECTION_PLANS[code].pgPlanCode).toBe(`Plan ${code}`);
      expect(PROTECTION_PLANS[code].label).toBe(`Plan ${code}`);
    }
  });

  it("carries the locked retail / wholesale / limit per tier", () => {
    expect(PROTECTION_PLANS.A).toMatchObject({ price: 12.99, wholesalePrice: 6, limitDollars: 1000 });
    expect(PROTECTION_PLANS.B).toMatchObject({ price: 7.99, wholesalePrice: 4, limitDollars: 500 });
    expect(PROTECTION_PLANS.C).toMatchObject({ price: 4.95, wholesalePrice: 2, limitDollars: 250 });
  });

  it("never sells a tier below its wholesale (margin must be positive)", () => {
    for (const code of PROTECTION_PLAN_CODES) {
      const { price, wholesalePrice } = PROTECTION_PLANS[code];
      expect(price).toBeGreaterThan(wholesalePrice);
      expect(wholesalePrice).toBeGreaterThan(0);
    }
  });

  it("keeps the display name in step with the limit (what the customer sees on the confirmation)", () => {
    for (const code of PROTECTION_PLAN_CODES) {
      const { name, limitDollars } = PROTECTION_PLANS[code];
      expect(name).toBe(`${formatLimit(limitDollars)} Protection`);
    }
  });

  it("orders tiers from most to least protection (the selector renders in this order)", () => {
    const limits = PROTECTION_PLAN_CODES.map((c) => PROTECTION_PLANS[c].limitDollars);
    expect([...limits].sort((a, b) => b - a)).toEqual(limits);
  });
});

describe("wire schema ↔ plan map", () => {
  it("accepts every tier code and an explicit null, nothing else", () => {
    for (const code of PROTECTION_PLAN_CODES) {
      expect(protectionPlanCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(protectionPlanCodeSchema.safeParse(null).success).toBe(true);
    for (const bad of [undefined, "", "D", "Plan A", true, 1, "none", "a"]) {
      expect(protectionPlanCodeSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("helpers", () => {
  it("isProtectionPlanCode is a strict guard", () => {
    expect(isProtectionPlanCode("A")).toBe(true);
    expect(isProtectionPlanCode("a")).toBe(false);
    expect(isProtectionPlanCode("Plan A")).toBe(false);
    expect(isProtectionPlanCode(null)).toBe(false);
    expect(isProtectionPlanCode(undefined)).toBe(false);
  });

  it("getProtectionPlan returns null for no-protection, the tier otherwise", () => {
    expect(getProtectionPlan(null)).toBeNull();
    expect(getProtectionPlan("B")).toBe(PROTECTION_PLANS.B);
  });

  it("protectionChoiceToCode maps the explicit decline to null", () => {
    expect(protectionChoiceToCode("none")).toBeNull();
    expect(protectionChoiceToCode("C")).toBe("C");
  });

  it("formatLimit pins en-US grouping", () => {
    expect(formatLimit(1000)).toBe("$1,000");
    expect(formatLimit(250)).toBe("$250");
  });
});

describe("PaymentIntent metadata pair", () => {
  it("protectionPremiumCents is integer cents, 0 for none", () => {
    expect(protectionPremiumCents(PROTECTION_PLANS.A)).toBe(1299);
    expect(protectionPremiumCents(PROTECTION_PLANS.C)).toBe(495);
    expect(protectionPremiumCents(null)).toBe(0);
  });

  it("protectionMetadataPatch writes the pair together and deletes it together (null = drop key)", () => {
    expect(protectionMetadataPatch(PROTECTION_PLANS.B)).toEqual({
      protectionPlanCode: "B",
      protectionPlanPrice: "7.99",
    });
    expect(protectionMetadataPatch(null)).toEqual({
      protectionPlanCode: null,
      protectionPlanPrice: null,
    });
  });

  it("readProtectionMetadata: the decision table", () => {
    expect(readProtectionMetadata({ protectionPlanCode: "B", protectionPlanPrice: "7.99" })).toEqual({
      kind: "tier",
      code: "B",
      premium: 7.99,
    });
    expect(readProtectionMetadata({})).toEqual({ kind: "none" });
    expect(readProtectionMetadata(null)).toEqual({ kind: "none" });
    expect(readProtectionMetadata({ customerEmail: "a@b.com" })).toEqual({ kind: "none" });
    // Pre-tier bundle: price only → Plan A at the charged premium (fulfilment),
    // and NOT silently "none".
    expect(readProtectionMetadata({ protectionPlanPrice: "10.99" })).toEqual({
      kind: "legacy_plan_a",
      premium: 10.99,
    });
    // Half pairs and garbage are refused, never guessed.
    expect(readProtectionMetadata({ protectionPlanCode: "A" }).kind).toBe("invalid");
    expect(readProtectionMetadata({ protectionPlanCode: "D", protectionPlanPrice: "1.00" }).kind).toBe("invalid");
    expect(readProtectionMetadata({ protectionPlanCode: "A", protectionPlanPrice: "0" }).kind).toBe("invalid");
    expect(readProtectionMetadata({ protectionPlanCode: "A", protectionPlanPrice: "abc" }).kind).toBe("invalid");
    expect(readProtectionMetadata({ protectionPlanPrice: "0" }).kind).toBe("invalid");
    // Empty strings count as absent (Stripe never stores them, but a client
    // sentinel convention once did).
    expect(readProtectionMetadata({ protectionPlanCode: "", protectionPlanPrice: "" })).toEqual({ kind: "none" });
  });

  it("round-trips: what the patch writes, the reader recovers", () => {
    for (const code of PROTECTION_PLAN_CODES) {
      const plan = PROTECTION_PLANS[code];
      const patch = protectionMetadataPatch(plan);
      const meta = {
        protectionPlanCode: patch.protectionPlanCode ?? undefined,
        protectionPlanPrice: patch.protectionPlanPrice ?? undefined,
      };
      expect(readProtectionMetadata(meta)).toEqual({ kind: "tier", code, premium: plan.price });
    }
  });
});

describe("customer-facing copy (renders into Terms, Help, the AI knowledge base)", () => {
  it("pins the three summaries word for word", () => {
    expect(PG_TIER_SUMMARY).toBe(
      "up to $1,000 of protection for $12.99, up to $500 for $7.99, or up to $250 for $4.95 per trip"
    );
    expect(PG_LIMIT_SUMMARY).toBe("$1,000, $500, or $250");
    expect(PG_NONREFUNDABLE_SUMMARY).toBe(
      "$6.00 for the $1,000 plan, $4.00 for the $500 plan, and $2.00 for the $250 plan"
    );
    expect(PG_WHOLESALE_SHORT_SUMMARY).toBe("$6.00 / $4.00 / $2.00");
  });

  it("uses none of the Park Guard 'words to avoid'", () => {
    for (const s of [PG_TIER_SUMMARY, PG_LIMIT_SUMMARY, PG_NONREFUNDABLE_SUMMARY]) {
      expect(s.toLowerCase()).not.toMatch(/insurance|coverage|supplemental|settlement/);
    }
  });
});
