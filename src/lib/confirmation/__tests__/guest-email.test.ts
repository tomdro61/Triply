import { describe, it, expect, afterEach, vi } from "vitest";
import {
  confirmationHandOff,
  guestProofHeaders,
  recallConfirmationEmail,
  recallConfirmationKey,
  rememberConfirmationEmail,
  rememberConfirmationKey,
  storeArrivalSecrets,
  stripSecretsFromAddressBar,
} from "../guest-email";

/**
 * A sessionStorage that works, throws on every call (blocked storage), or
 * accepts writes but keeps nothing (a full or wiped store).
 */
function stubStorage(mode: "ok" | "blocked" | "forgets") {
  const store = new Map<string, string>();
  const sessionStorage = {
    setItem: (k: string, v: string) => {
      if (mode === "blocked") throw new Error("SecurityError");
      if (mode === "ok") store.set(k, v);
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

  it("with a booking key: both stored → in-app, the URL carries neither; the page finds the key", () => {
    stubStorage("ok");
    expect(confirmationHandOff("/confirmation/RTL1?lot=reslab-2", "RTL1", "dana@example.com", "AbCdEfGhIjKlMnOpQrStUv")).toEqual({
      url: "/confirmation/RTL1?lot=reslab-2",
      fullLoad: false,
    });
    expect(recallConfirmationKey("RTL1")).toBe("AbCdEfGhIjKlMnOpQrStUv");
    expect(recallConfirmationEmail("RTL1")).toBe("dana@example.com");
  });

  it("with a booking key and storage blocked → both ride in the URL, and a FULL page load", () => {
    stubStorage("blocked");
    expect(confirmationHandOff("/confirmation/RTL1?lot=reslab-2", "RTL1", "dana@example.com", "AbCdEfGhIjKlMnOpQrStUv")).toEqual({
      url: "/confirmation/RTL1?lot=reslab-2&booking_key=AbCdEfGhIjKlMnOpQrStUv&email=dana%40example.com",
      fullLoad: true,
    });
    // A key with no email still hands the key over.
    expect(confirmationHandOff("/confirmation/RTL1", "RTL1", "", "AbCdEfGhIjKlMnOpQrStUv")).toEqual({
      url: "/confirmation/RTL1?booking_key=AbCdEfGhIjKlMnOpQrStUv",
      fullLoad: true,
    });
  });

  it("no email to hand over → the path as is, in-app", () => {
    stubStorage("blocked");
    expect(confirmationHandOff("/confirmation/RTL1", "RTL1", "")).toEqual({ url: "/confirmation/RTL1", fullLoad: false });
  });

  it("the booking key is stored apart from the email, per booking; blocked storage → false / null", () => {
    stubStorage("ok");
    expect(rememberConfirmationKey("RTL1", "AbCdEfGhIjKlMnOpQrStUv")).toBe(true);
    expect(rememberConfirmationEmail("RTL1", "dana@example.com")).toBe(true);
    expect(recallConfirmationKey("RTL1")).toBe("AbCdEfGhIjKlMnOpQrStUv");
    expect(recallConfirmationEmail("RTL1")).toBe("dana@example.com");
    expect(recallConfirmationKey("RTL2")).toBeNull();

    stubStorage("blocked");
    expect(rememberConfirmationKey("RTL1", "AbCdEfGhIjKlMnOpQrStUv")).toBe(false);
    expect(recallConfirmationKey("RTL1")).toBeNull();
  });

  it("a write that is not kept counts as not stored (read back to check)", () => {
    stubStorage("forgets");
    expect(rememberConfirmationEmail("RTL1", "dana@example.com")).toBe(false);
    expect(rememberConfirmationKey("RTL1", "AbCdEfGhIjKlMnOpQrStUv")).toBe(false);
    expect(storeArrivalSecrets("RTL1", { email: "dana@example.com", bookingKey: "AbCdEfGhIjKlMnOpQrStUv" })).toEqual([]);
  });

  it("storeArrivalSecrets returns only what it stored: both, key only, email only, none", () => {
    stubStorage("ok");
    expect(storeArrivalSecrets("RTL1", { email: "dana@example.com", bookingKey: "AbCdEfGhIjKlMnOpQrStUv" })).toEqual([
      "email",
      "booking_key",
    ]);
    expect(recallConfirmationKey("RTL1")).toBe("AbCdEfGhIjKlMnOpQrStUv");
    expect(storeArrivalSecrets("RTL2", { email: null, bookingKey: "AbCdEfGhIjKlMnOpQrStUv" })).toEqual(["booking_key"]);
    expect(storeArrivalSecrets("RTL3", { email: "dana@example.com", bookingKey: null })).toEqual(["email"]);
    expect(storeArrivalSecrets("RTL4", { email: null, bookingKey: null })).toEqual([]);

    stubStorage("blocked");
    expect(storeArrivalSecrets("RTL1", { email: "dana@example.com", bookingKey: "AbCdEfGhIjKlMnOpQrStUv" })).toEqual([]);
  });

  it("guestProofHeaders: the link's key, else the stored one; typed email, else the link's, else the stored one", () => {
    stubStorage("ok");
    rememberConfirmationKey("RTL1", "StoredKeyStoredKeyStor");
    rememberConfirmationEmail("RTL1", "stored@example.com");
    expect(guestProofHeaders("RTL1", { typedEmail: null, arrivalEmail: null, arrivalKey: null })).toEqual({
      "x-booking-key": "StoredKeyStoredKeyStor",
      "x-booking-email": "stored@example.com",
    });
    expect(
      guestProofHeaders("RTL1", { typedEmail: "typed@example.com", arrivalEmail: "link@example.com", arrivalKey: "LinkKeyLinkKeyLinkKeyL" })
    ).toEqual({ "x-booking-key": "LinkKeyLinkKeyLinkKeyL", "x-booking-email": "typed@example.com" });
    expect(guestProofHeaders("RTL1", { typedEmail: null, arrivalEmail: "link@example.com", arrivalKey: null })).toEqual({
      "x-booking-key": "StoredKeyStoredKeyStor",
      "x-booking-email": "link@example.com",
    });
    // Nothing known: no proof headers at all.
    expect(guestProofHeaders("RTL9", { typedEmail: null, arrivalEmail: null, arrivalKey: null })).toEqual({});

    stubStorage("blocked");
    expect(guestProofHeaders("RTL1", { typedEmail: null, arrivalEmail: "link@example.com", arrivalKey: "LinkKeyLinkKeyLinkKeyL" })).toEqual({
      "x-booking-key": "LinkKeyLinkKeyLinkKeyL",
      "x-booking-email": "link@example.com",
    });
  });

  it("stripSecretsFromAddressBar drops only the params it is given, keeps the rest, and never throws", () => {
    const replaceState = vi.fn();
    const href =
      "https://www.triplypro.com/confirmation/RTL1?lot=reslab-2&booking_key=AbCdEfGhIjKlMnOpQrStUv&email=dana%40example.com#qr";
    vi.stubGlobal("window", {
      location: { href },
      history: { state: { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: {} }, replaceState },
    });
    stripSecretsFromAddressBar(["email", "booking_key"]);
    // null, never Next's own state: with its marker Next skips the router sync
    // and would write the params back on the next router update.
    expect(replaceState).toHaveBeenCalledWith(null, "", "/confirmation/RTL1?lot=reslab-2#qr");

    // Only what was stored is stripped: an unstored key stays for a reload.
    replaceState.mockClear();
    stripSecretsFromAddressBar(["email"]);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/confirmation/RTL1?lot=reslab-2&booking_key=AbCdEfGhIjKlMnOpQrStUv#qr");

    replaceState.mockClear();
    stripSecretsFromAddressBar(["booking_key"]);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/confirmation/RTL1?lot=reslab-2&email=dana%40example.com#qr");

    // Nothing to strip → no history write.
    replaceState.mockClear();
    stripSecretsFromAddressBar([]);
    vi.stubGlobal("window", {
      location: { href: "https://www.triplypro.com/confirmation/RTL1?lot=reslab-2" },
      history: { state: null, replaceState },
    });
    stripSecretsFromAddressBar(["email", "booking_key"]);
    expect(replaceState).not.toHaveBeenCalled();

    vi.stubGlobal("window", {
      location: { href: "https://www.triplypro.com/confirmation/RTL1?email=x&booking_key=y" },
      history: {
        state: null,
        replaceState: () => {
          throw new Error("SecurityError");
        },
      },
    });
    expect(() => stripSecretsFromAddressBar(["email", "booking_key"])).not.toThrow();
  });
});
