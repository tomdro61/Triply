import { describe, it, expect, afterEach } from "vitest";
import { confirmationAuthParam, mintConfirmationKey, verifyConfirmationKey } from "../link-key";

describe("confirmation link key", () => {
  const original = process.env.CONFIRMATION_LINK_SECRET;
  afterEach(() => {
    process.env.CONFIRMATION_LINK_SECRET = original;
  });

  it("verifies the key it minted for the same booking", () => {
    process.env.CONFIRMATION_LINK_SECRET = "test-secret";
    const key = mintConfirmationKey("RTL123");
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(verifyConfirmationKey("RTL123", key)).toBe(true);
  });

  it("refuses another booking's key, a tampered key and a missing key", () => {
    process.env.CONFIRMATION_LINK_SECRET = "test-secret";
    const key = mintConfirmationKey("RTL123")!;
    expect(verifyConfirmationKey("RTL124", key)).toBe(false);
    expect(verifyConfirmationKey("RTL123", key.slice(0, -1) + (key.endsWith("A") ? "B" : "A"))).toBe(false);
    expect(verifyConfirmationKey("RTL123", key.slice(0, 10))).toBe(false);
    expect(verifyConfirmationKey("RTL123", null)).toBe(false);
  });

  it("a key minted under another secret does not verify", () => {
    process.env.CONFIRMATION_LINK_SECRET = "old-secret";
    const key = mintConfirmationKey("RTL123");
    process.env.CONFIRMATION_LINK_SECRET = "new-secret";
    expect(verifyConfirmationKey("RTL123", key)).toBe(false);
  });

  it("without the secret: no key, nothing verifies, links keep the legacy email param", () => {
    delete process.env.CONFIRMATION_LINK_SECRET;
    expect(mintConfirmationKey("RTL123")).toBeNull();
    expect(verifyConfirmationKey("RTL123", "x".repeat(32))).toBe(false);
    expect(confirmationAuthParam("RTL123", "guest@example.com")).toEqual(["email", "guest@example.com"]);
  });

  it("with the secret: links carry k and never the address", () => {
    process.env.CONFIRMATION_LINK_SECRET = "test-secret";
    const [name, value] = confirmationAuthParam("RTL123", "guest@example.com");
    expect(name).toBe("k");
    expect(value).not.toContain("guest");
    expect(verifyConfirmationKey("RTL123", value)).toBe(true);
  });
});
