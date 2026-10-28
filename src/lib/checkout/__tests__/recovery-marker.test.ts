import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { saveRecoveryMarker, readRecoveryMarker, clearRecoveryMarker } from "../recovery-marker";

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

  it("ignores a marker older than 24 hours (a restored tab days later must not silently resume)", () => {
    saveRecoveryMarker({ paymentIntentId: "pi_123", clientSecret: "s" });
    const saved = readRecoveryMarker();
    expect(saved).not.toBeNull();
    expect(readRecoveryMarker(saved!.savedAt + 24 * 60 * 60 * 1000 + 1)).toBeNull();
    expect(readRecoveryMarker(saved!.savedAt + 23 * 60 * 60 * 1000)).not.toBeNull();
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
});
