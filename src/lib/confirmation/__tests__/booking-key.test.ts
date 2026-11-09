import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "crypto";
import {
  BOOKING_KEY_SHAPE,
  bookingKey,
  isBookingLinkConfigError,
  verifyBookingKey,
} from "../booking-key";
import { bucketHash } from "../guest-lookup-limit";

afterEach(() => {
  vi.unstubAllEnvs();
});

const withSecret = (secret: string) => vi.stubEnv("BOOKING_LINK_SIGNING_SECRET", secret);

describe("booking key", () => {
  it("round trip: a 22-character base64url key that verifies for its own number only", () => {
    withSecret("test-secret-one");
    const key = bookingKey("RTL900001");
    expect(key).toMatch(BOOKING_KEY_SHAPE);
    expect(verifyBookingKey("RTL900001", key)).toBe(true);
    expect(verifyBookingKey("RTL900002", key)).toBe(false);
    // The exact string: no trimming or case folding.
    expect(verifyBookingKey("rtl900001", key)).toBe(false);
    expect(verifyBookingKey("RTL900001 ", key)).toBe(false);
    // Same input, same key (re-sent emails carry an identical link).
    expect(bookingKey("RTL900001")).toBe(key);
  });

  it("a one-character change, a wrong length or the wrong alphabet never verifies", () => {
    withSecret("test-secret-one");
    const key = bookingKey("TRP-7K3M9QXA");
    for (let i = 0; i < key.length; i++) {
      for (const c of ["A", "B", "Q", "g", "w", "_", "-", "0", "9"]) {
        if (key[i] === c) continue;
        const changed = key.slice(0, i) + c + key.slice(i + 1);
        expect(verifyBookingKey("TRP-7K3M9QXA", changed)).toBe(false);
      }
    }
    expect(verifyBookingKey("TRP-7K3M9QXA", key.slice(0, 21))).toBe(false);
    expect(verifyBookingKey("TRP-7K3M9QXA", key + "A")).toBe(false);
    expect(verifyBookingKey("TRP-7K3M9QXA", key.replace(/[A-Za-z0-9]/, "+"))).toBe(false);
    expect(verifyBookingKey("TRP-7K3M9QXA", "")).toBe(false);
    expect(verifyBookingKey("", key)).toBe(false);
  });

  it("compares the TEXT: another spelling that decodes to the same 16 bytes never verifies", () => {
    withSecret("test-secret-one");
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (const number of ["TRP-7K3M9QXA", "RTL900001", "RTL869257"]) {
      const key = bookingKey(number);
      // The 22nd character carries 2 key bits + 4 spare bits: flip a spare one.
      const alt = key.slice(0, 21) + ALPHABET[ALPHABET.indexOf(key[21]) ^ 1];
      expect(Buffer.from(alt, "base64url").equals(Buffer.from(key, "base64url"))).toBe(true);
      expect(verifyBookingKey(number, alt)).toBe(false);
    }
  });

  it("a value made with the same secret for another purpose never verifies", () => {
    withSecret("test-secret-one");
    const number = "RTL900001";
    // The limiter's bucket hash for this number, cut to the key's shape.
    expect(verifyBookingKey(number, bucketHash("number", number).slice(0, 22))).toBe(false);
    // An HMAC over the bare number (no domain prefix).
    const bare = crypto.createHmac("sha256", "test-secret-one").update(number).digest().subarray(0, 16).toString("base64url");
    expect(verifyBookingKey(number, bare)).toBe(false);
  });

  it("two secrets never verify each other's keys (each environment has its own)", () => {
    withSecret("production-secret");
    const prodKey = bookingKey("RTL900001");
    withSecret("preview-secret");
    expect(verifyBookingKey("RTL900001", prodKey)).toBe(false);
    expect(bookingKey("RTL900001")).not.toBe(prodKey);
  });

  it("a missing secret throws a typed config error, never 'a bad key'", () => {
    withSecret("");
    expect(() => bookingKey("RTL900001")).toThrow(/BOOKING_LINK_SIGNING_SECRET/);
    let caught: unknown;
    try {
      verifyBookingKey("RTL900001", "AbCdEfGhIjKlMnOpQrStUv");
    } catch (err) {
      caught = err;
    }
    expect(isBookingLinkConfigError(caught)).toBe(true);
    // A wrong shape is refused before the secret is needed.
    expect(verifyBookingKey("RTL900001", "short")).toBe(false);
  });
});
