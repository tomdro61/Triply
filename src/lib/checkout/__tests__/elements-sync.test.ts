import { afterEach, describe, expect, it, vi } from "vitest";
import { syncElementsAmount } from "../elements-sync";

describe("syncElementsAmount", () => {
  it("a clean fetchUpdates is ok", async () => {
    expect(await syncElementsAmount({ fetchUpdates: async () => ({}) })).toEqual({ ok: true });
  });

  it("Stripe answering with an error is a failure carrying its message", async () => {
    expect(
      await syncElementsAmount({
        fetchUpdates: async () => ({ error: { message: "Invalid PaymentIntent", status: "invalid_request_error" } }),
      })
    ).toEqual({ ok: false, message: "Invalid PaymentIntent" });
  });

  it("a rejection (network) is a failure, never a throw into the form", async () => {
    expect(
      await syncElementsAmount({
        fetchUpdates: async () => {
          throw new Error("Failed to fetch");
        },
      })
    ).toEqual({ ok: false, message: "Failed to fetch" });
  });

  it("an error object without a message still reads as a failure", async () => {
    expect(await syncElementsAmount({ fetchUpdates: async () => ({ error: { message: "" } }) })).toEqual({
      ok: false,
      message: "fetchUpdates returned an error",
    });
  });

  it("a fetchUpdates that never settles fails at the deadline (Pay must not spin forever)", async () => {
    vi.useFakeTimers();
    const pending = syncElementsAmount({ fetchUpdates: () => new Promise(() => {}) }, 10_000);
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, message: "fetchUpdates timed out after 10000ms" });
  });

  it("a fast answer wins the race and the deadline timer is cleared", async () => {
    vi.useFakeTimers();
    expect(await syncElementsAmount({ fetchUpdates: async () => ({}) }, 10_000)).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
