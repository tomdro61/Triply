/**
 * The post-authorization rule (launch-QA finding #8, Oct 28 2026): once the
 * card is held, only a 402 or a 409 — the answers in which the engine has
 * released the hold — keep the customer on the checkout page. Everything else
 * hands off to /checkout/complete, which polls the engine for the truth.
 */
import { describe, it, expect } from "vitest";
import { postAuthActionFor } from "../post-auth-outcome";

describe("postAuthActionFor", () => {
  it("200 with a reservation number → confirmed", () => {
    expect(
      postAuthActionFor({ status: 200, body: { success: true, reservation: { reservationNumber: "RTL123" } } })
    ).toEqual({ kind: "confirmed", reservationNumber: "RTL123" });
  });

  it("200 without a usable reservation number → hand-off (the booking exists; the complete page re-reads it)", () => {
    expect(postAuthActionFor({ status: 200, body: { success: true } })).toEqual({
      kind: "handoff",
      reason: "success_without_reservation_number",
    });
    expect(postAuthActionFor({ status: 200, body: { reservation: { reservationNumber: "" } } }).kind).toBe("handoff");
    expect(postAuthActionFor({ status: 200, body: null }).kind).toBe("handoff");
  });

  it("202 → hand-off (another path is completing the booking)", () => {
    expect(postAuthActionFor({ status: 202, body: { pending: true } })).toEqual({ kind: "handoff", reason: "pending" });
  });

  it.each([
    [409, "This parking option sold out while you were checking out. You have not been charged."],
    [409, "It looks like this booking was already submitted. We've cancelled the duplicate payment — check your email for the original confirmation."],
    [409, "This payment was refunded and can't be used for a booking. Please start a new search."],
    [402, "Payment has not been completed"],
  ])("%s → stay on checkout with the engine's own message", (status, error) => {
    expect(postAuthActionFor({ status, body: { error } })).toEqual({ kind: "stay", message: error });
  });

  it("409 carrying a definitive `failed` outcome's own message → stay", () => {
    expect(
      postAuthActionFor({
        status: 409,
        body: { error: "This checkout expired and was not completed. You have not been charged — please search again." },
      })
    ).toMatchObject({ kind: "stay" });
  });

  it("402 / 409 WITHOUT the engine's JSON message (a platform HTML page) → hand-off, not a live Pay button", () => {
    expect(postAuthActionFor({ status: 409, body: null })).toEqual({ kind: "handoff", reason: "non_json_409" });
    expect(postAuthActionFor({ status: 402, body: null })).toEqual({ kind: "handoff", reason: "non_json_402" });
    expect(postAuthActionFor({ status: 402, body: { error: "   " } })).toEqual({ kind: "handoff", reason: "non_json_402" });
  });

  it("our own 502 needsSupport → hand-off, never a red 'Payment Error' over a held card", () => {
    expect(
      postAuthActionFor({
        status: 502,
        body: { error: "We're confirming your reservation with the parking facility.", needsSupport: true },
      })
    ).toEqual({ kind: "handoff", reason: "http_502" });
  });

  it("generic 500 → hand-off", () => {
    expect(postAuthActionFor({ status: 500, body: { error: "Failed to create reservation. Please try again." } })).toEqual({
      kind: "handoff",
      reason: "http_500",
    });
  });

  it("gateway 502 / 504 with an HTML body (no JSON) → hand-off", () => {
    expect(postAuthActionFor({ status: 502, body: null })).toEqual({ kind: "handoff", reason: "non_json_502" });
    expect(postAuthActionFor({ status: 504, body: null })).toEqual({ kind: "handoff", reason: "non_json_504" });
  });

  it("network failure (no answer at all) → hand-off", () => {
    expect(postAuthActionFor({ status: 0, body: null })).toEqual({ kind: "handoff", reason: "network" });
  });

  it("400 after the charge → hand-off (the staged row + webhook finish the booking; the card is held)", () => {
    expect(
      postAuthActionFor({
        status: 400,
        body: { error: "We're finishing your booking — your confirmation email will follow shortly. Please don't pay again." },
      })
    ).toEqual({ kind: "handoff", reason: "http_400" });
  });

  it("never returns 'stay' for any status other than 402 / 409", () => {
    for (const status of [0, 400, 401, 403, 404, 408, 429, 500, 502, 503, 504]) {
      expect(postAuthActionFor({ status, body: { error: "x" } }).kind).toBe("handoff");
    }
  });
});
