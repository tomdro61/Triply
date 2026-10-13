/**
 * Pins DIRECT_BOOKING_OPEN per test. The real flag is a compile-time constant
 * (true since go-live, 2026-10-13); tests of behaviour that differs before and
 * after go-live (the production checkout guard, the E1 empty-day manifest) set
 * `flagSwitch.open` instead of depending on the constant's current value.
 *
 *   vi.mock("@/lib/direct/flag", async (importOriginal) =>
 *     (await import("@/lib/direct/__tests__/flag-switch")).mockFlag(importOriginal));
 */
import type * as Flag from "../flag";

export const flagSwitch = { open: false };

export async function mockFlag(importOriginal: () => Promise<typeof Flag>) {
  const actual = await importOriginal();
  return {
    ...actual,
    get DIRECT_BOOKING_OPEN() {
      return flagSwitch.open;
    },
    isDirectCheckoutOpen: (env: NodeJS.ProcessEnv = process.env) => actual.checkoutOpenFor(env, flagSwitch.open),
  };
}
