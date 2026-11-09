import { describe, it, expect } from "vitest";
import { confirmationErrorScreen, fetchStatusFor } from "../fetch-status";

describe("fetchStatusFor", () => {
  it("maps each answer to its own screen; 429 and 503 are never the generic error", () => {
    expect(fetchStatusFor(200)).toBe("ok");
    expect(fetchStatusFor(403)).toBe("auth-required");
    expect(fetchStatusFor(404)).toBe("not-found");
    expect(fetchStatusFor(429)).toBe("too-many-tries");
    expect(fetchStatusFor(503)).toBe("unavailable");
    expect(fetchStatusFor(500)).toBe("error");
    expect(fetchStatusFor(502)).toBe("error");
  });
});

describe("confirmationErrorScreen", () => {
  it("too many tries: says the booking is confirmed if they paid, shows the number, offers sign-in, never the email box", () => {
    const guest = confirmationErrorScreen("too-many-tries", false);
    expect(guest.headline).toBe("Too Many Tries");
    expect(guest.message).toContain("your booking is confirmed");
    expect(guest).toMatchObject({ showNumber: true, showSignIn: true, showEmailBox: false });
    expect(confirmationErrorScreen("too-many-tries", true)).toMatchObject({ showSignIn: false, showEmailBox: false });
  });

  it("unavailable (503): its own screen, not 'Something Went Wrong', and no 'too many tries' wording", () => {
    const s = confirmationErrorScreen("unavailable", false);
    expect(s.headline).not.toBe("Something Went Wrong");
    expect(s.message).not.toMatch(/too many/i);
    expect(s).toMatchObject({ showNumber: true, showSignIn: true, showEmailBox: false });
  });

  it("auth required: the email box for a guest only", () => {
    expect(confirmationErrorScreen("auth-required", false).showEmailBox).toBe(true);
    expect(confirmationErrorScreen("auth-required", true).showEmailBox).toBe(false);
  });

  it("not found and the generic error offer neither the number nor sign-in", () => {
    for (const status of ["not-found", "error"] as const) {
      expect(confirmationErrorScreen(status, false)).toMatchObject({ showNumber: false, showSignIn: false, showEmailBox: false });
    }
  });
});
