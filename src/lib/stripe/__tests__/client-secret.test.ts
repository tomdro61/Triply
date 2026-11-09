import { describe, it, expect, beforeEach, vi } from "vitest";

const retrieve = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stripe/client", () => ({ stripe: { paymentIntents: { retrieve } } }));

import { paymentIntentSecretMatches, secretsMatch } from "../client-secret";

beforeEach(() => {
  retrieve.mockReset();
});

describe("secretsMatch", () => {
  it("equal → true; same length but different → false; different length or empty → false", () => {
    const secret = "pi_3Abc_secret_K9xQ2mT7vR";
    expect(secretsMatch(secret, secret)).toBe(true);
    // One character flipped: the length check alone would accept it.
    expect(secretsMatch(secret, secret.slice(0, -1) + "S")).toBe(false);
    expect(secretsMatch(secret, "pi_3Abd_secret_K9xQ2mT7vR")).toBe(false);
    expect(secretsMatch(secret, secret + "x")).toBe(false);
    expect(secretsMatch(secret, "")).toBe(false);
    expect(secretsMatch("", "")).toBe(true);
  });
});

describe("paymentIntentSecretMatches", () => {
  it("reads THE PaymentIntent it is given and compares with that one's secret", async () => {
    retrieve.mockImplementation(async (id: string) => ({ id, client_secret: `${id}_secret_s3cr3t` }));
    expect(await paymentIntentSecretMatches("pi_victim", "pi_victim_secret_s3cr3t")).toBe("match");
    // An attacker's own valid secret, for their own PaymentIntent, is not this one's.
    expect(await paymentIntentSecretMatches("pi_victim", "pi_attacker_secret_s3cr3t")).toBe("mismatch");
    expect(retrieve).toHaveBeenLastCalledWith("pi_victim", {}, { timeout: 3000, maxNetworkRetries: 0 });
  });

  it("no client secret on the PaymentIntent → mismatch; a Stripe failure → unknown, never a match", async () => {
    retrieve.mockResolvedValue({ id: "pi_1", client_secret: null });
    expect(await paymentIntentSecretMatches("pi_1", "pi_1_secret_x")).toBe("mismatch");
    retrieve.mockRejectedValue(new Error("Stripe down"));
    expect(await paymentIntentSecretMatches("pi_1", "pi_1_secret_x")).toEqual({ unknown: "Stripe down" });
  });
});
