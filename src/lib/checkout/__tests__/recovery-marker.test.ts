import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  saveRecoveryMarker,
  readRecoveryMarker,
  clearRecoveryMarker,
  resolveCredentials,
  markerActionFor,
} from "../recovery-marker";

/** A minimal sessionStorage for the node test environment. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  };
}

const g = globalThis as { sessionStorage?: Storage };

describe("recovery marker", () => {
  beforeEach(() => {
    g.sessionStorage = fakeStorage();
  });
  afterEach(() => {
    delete g.sessionStorage;
  });

  it("round-trips the payment reference for this tab", () => {
    saveRecoveryMarker({ paymentIntentId: "pi_123", clientSecret: "pi_123_secret_abc" });
    expect(readRecoveryMarker()).toMatchObject({ paymentIntentId: "pi_123", clientSecret: "pi_123_secret_abc" });
  });

  it("clear removes it", () => {
    saveRecoveryMarker({ paymentIntentId: "pi_123", clientSecret: "s" });
    clearRecoveryMarker();
    expect(readRecoveryMarker()).toBeNull();
  });

  it("has no age limit: the hold lives ~7 days and only the engine's answer retires a marker", () => {
    g.sessionStorage!.setItem(
      "triply:checkout-recovery",
      JSON.stringify({ paymentIntentId: "pi_old", clientSecret: "s", savedAt: Date.now() - 5 * 24 * 60 * 60 * 1000 })
    );
    expect(readRecoveryMarker()).toMatchObject({ paymentIntentId: "pi_old" });
  });

  it("rejects malformed or tampered contents", () => {
    g.sessionStorage!.setItem("triply:checkout-recovery", "not json");
    expect(readRecoveryMarker()).toBeNull();
    g.sessionStorage!.setItem("triply:checkout-recovery", JSON.stringify({ paymentIntentId: "nope", clientSecret: "s", savedAt: Date.now() }));
    expect(readRecoveryMarker()).toBeNull();
    g.sessionStorage!.setItem("triply:checkout-recovery", JSON.stringify({ paymentIntentId: "pi_1", clientSecret: "", savedAt: Date.now() }));
    expect(readRecoveryMarker()).toBeNull();
    g.sessionStorage!.setItem("triply:checkout-recovery", JSON.stringify({ paymentIntentId: "pi_1", clientSecret: "s" }));
    expect(readRecoveryMarker()).toBeNull();
  });

  it("never throws when storage is unavailable (server render, blocked site data)", () => {
    delete g.sessionStorage;
    expect(() => saveRecoveryMarker({ paymentIntentId: "pi_1", clientSecret: "s" })).not.toThrow();
    expect(readRecoveryMarker()).toBeNull();
    expect(() => clearRecoveryMarker()).not.toThrow();
  });

  describe("resolveCredentials", () => {
    const marker = { paymentIntentId: "pi_marker", clientSecret: "marker_secret", savedAt: 1 };

    it("URL parameters win over the marker (a fresh return or hand-off is always the newest payment)", () => {
      expect(
        resolveCredentials({ paymentIntentId: "pi_url", clientSecret: "url_secret" }, () => marker)
      ).toEqual({ credentials: { paymentIntentId: "pi_url", clientSecret: "url_secret" }, source: "url" });
    });

    it("falls back to the marker when the URL has nothing (refresh after the scrub)", () => {
      expect(resolveCredentials({ paymentIntentId: null, clientSecret: null }, () => marker)).toEqual({
        credentials: { paymentIntentId: "pi_marker", clientSecret: "marker_secret" },
        source: "marker",
      });
    });

    it("half a URL (only payment_intent) does not count — the marker is used instead", () => {
      expect(resolveCredentials({ paymentIntentId: "pi_url", clientSecret: null }, () => marker).source).toBe("marker");
    });

    it("nothing anywhere → none", () => {
      expect(resolveCredentials({ paymentIntentId: null, clientSecret: null }, () => null)).toEqual({
        credentials: { paymentIntentId: null, clientSecret: null },
        source: "none",
      });
    });
  });

  describe("markerActionFor", () => {
    it.each(["booked", "payment_failed", "payment_incomplete", "failed"])("%s → clear (money settled)", (state) => {
      expect(markerActionFor(state)).toBe("clear");
    });
    it.each(["needs_support", "pending", "something_new", undefined, null])("%s → keep (unresolved)", (state) => {
      expect(markerActionFor(state)).toBe("keep");
    });
  });
});
