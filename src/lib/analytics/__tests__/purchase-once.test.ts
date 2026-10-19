import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { markPurchaseToTrack, takePurchaseToTrack } from "../purchase-once";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

function throwingStorage(): Storage {
  const fail = () => {
    throw new DOMException("blocked", "SecurityError");
  };
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail };
}

describe("purchase-once", () => {
  let session: Storage;
  let local: Storage;

  beforeEach(() => {
    session = memoryStorage();
    local = memoryStorage();
    vi.stubGlobal("sessionStorage", session);
    vi.stubGlobal("localStorage", local);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fires once for the booking checkout just marked", () => {
    markPurchaseToTrack("RTL123");
    expect(takePurchaseToTrack("RTL123")).toBe(true);
    // Refresh / revisit in the same tab: mark is gone.
    expect(takePurchaseToTrack("RTL123")).toBe(false);
  });

  it("never fires without a mark (email link, My Reservations, another device)", () => {
    expect(takePurchaseToTrack("RTL123")).toBe(false);
  });

  it("ignores a mark for a different booking and keeps it", () => {
    markPurchaseToTrack("RTL999");
    expect(takePurchaseToTrack("RTL123")).toBe(false);
    expect(takePurchaseToTrack("RTL999")).toBe(true);
  });

  it("does not fire again for an id already sent from this browser (restored tab)", () => {
    markPurchaseToTrack("TRP-ABC");
    expect(takePurchaseToTrack("TRP-ABC")).toBe(true);
    markPurchaseToTrack("TRP-ABC");
    expect(takePurchaseToTrack("TRP-ABC")).toBe(false);
  });

  it("keeps the sent list bounded", () => {
    for (let i = 0; i < 60; i++) {
      markPurchaseToTrack(`RTL${i}`);
      expect(takePurchaseToTrack(`RTL${i}`)).toBe(true);
    }
    const sent: unknown = JSON.parse(local.getItem("triply:purchases-tracked") ?? "[]");
    expect(Array.isArray(sent) && sent.length).toBe(50);
  });

  it("tolerates a corrupt sent list", () => {
    local.setItem("triply:purchases-tracked", "{not json");
    markPurchaseToTrack("RTL1");
    expect(takePurchaseToTrack("RTL1")).toBe(true);
  });

  it("fires nothing when sessionStorage is blocked", () => {
    vi.stubGlobal("sessionStorage", throwingStorage());
    expect(() => markPurchaseToTrack("RTL1")).not.toThrow();
    expect(takePurchaseToTrack("RTL1")).toBe(false);
  });

  it("still fires once when only localStorage is blocked", () => {
    vi.stubGlobal("localStorage", throwingStorage());
    markPurchaseToTrack("RTL1");
    expect(takePurchaseToTrack("RTL1")).toBe(true);
    expect(takePurchaseToTrack("RTL1")).toBe(false);
  });
});
