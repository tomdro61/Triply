import { describe, it, expect, afterEach, vi } from "vitest";
import {
  confirmationHandOff,
  recallConfirmationEmail,
  rememberConfirmationEmail,
  stripEmailFromAddressBar,
} from "../guest-email";

/** A sessionStorage that works, or throws on every call (blocked storage). */
function stubStorage(mode: "ok" | "blocked") {
  const store = new Map<string, string>();
  const sessionStorage = {
    setItem: (k: string, v: string) => {
      if (mode === "blocked") throw new Error("SecurityError");
      store.set(k, v);
    },
    getItem: (k: string) => {
      if (mode === "blocked") throw new Error("SecurityError");
      return store.get(k) ?? null;
    },
  };
  vi.stubGlobal("window", { sessionStorage });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("guest email hand-off to /confirmation", () => {
  it("remember + recall round-trip per booking; blocked storage → false / null, never throws", () => {
    stubStorage("ok");
    expect(rememberConfirmationEmail("RTL1", "dana@example.com")).toBe(true);
    expect(recallConfirmationEmail("RTL1")).toBe("dana@example.com");
    expect(recallConfirmationEmail("RTL2")).toBeNull();

    stubStorage("blocked");
    expect(rememberConfirmationEmail("RTL1", "dana@example.com")).toBe(false);
    expect(recallConfirmationEmail("RTL1")).toBeNull();
  });

  it("stored → the URL never carries the email, in-app navigation", () => {
    stubStorage("ok");
    expect(confirmationHandOff("/confirmation/RTL1?lot=reslab-2", "RTL1", "dana@example.com")).toEqual({
      url: "/confirmation/RTL1?lot=reslab-2",
      fullLoad: false,
    });
    expect(recallConfirmationEmail("RTL1")).toBe("dana@example.com");
  });

  it("storage blocked → ?email= is added (encoded) and the caller must do a FULL page load", () => {
    stubStorage("blocked");
    expect(confirmationHandOff("/confirmation/RTL1?lot=reslab-2", "RTL1", "dana+trip@example.com")).toEqual({
      url: "/confirmation/RTL1?lot=reslab-2&email=dana%2Btrip%40example.com",
      fullLoad: true,
    });
    // A path with no query gets a well-formed one.
    expect(confirmationHandOff("/confirmation/RTL1", "RTL1", "a@b.co").url).toBe("/confirmation/RTL1?email=a%40b.co");
  });

  it("no email to hand over → the path as is, in-app", () => {
    stubStorage("blocked");
    expect(confirmationHandOff("/confirmation/RTL1", "RTL1", "")).toEqual({ url: "/confirmation/RTL1", fullLoad: false });
  });

  it("stripEmailFromAddressBar drops only email, keeps the rest, and never throws", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://www.triplypro.com/confirmation/RTL1?lot=reslab-2&email=dana%40example.com#qr" },
      history: { state: { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: {} }, replaceState },
    });
    stripEmailFromAddressBar();
    // null, never Next's own state: with its marker Next skips the router sync
    // and would write ?email= back on the next router update.
    expect(replaceState).toHaveBeenCalledWith(null, "", "/confirmation/RTL1?lot=reslab-2#qr");

    vi.stubGlobal("window", {
      location: { href: "https://www.triplypro.com/confirmation/RTL1?email=x" },
      history: {
        state: null,
        replaceState: () => {
          throw new Error("SecurityError");
        },
      },
    });
    expect(() => stripEmailFromAddressBar()).not.toThrow();
  });
});
