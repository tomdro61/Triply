import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runPaymentSubmit, type SubmitErrorLike } from "../payment-submit";

const dismissed: SubmitErrorLike = {
  type: "validation_error",
  code: "payment_sheet_dismissed",
  message: "The customer closed the sheet.",
};

/** Records the order in which the three steps were entered. */
function harness(opts: {
  submit?: () => Promise<{ error?: SubmitErrorLike; selectedPaymentMethod?: string }>;
  stage?: () => Promise<void>;
  confirm?: () => Promise<string>;
  withStage?: boolean;
} = {}) {
  const order: string[] = [];
  const submit = vi.fn(async () => {
    order.push("submit");
    return opts.submit ? opts.submit() : { selectedPaymentMethod: "apple_pay" };
  });
  const stage = vi.fn(async () => {
    order.push("stage");
    if (opts.stage) await opts.stage();
  });
  const confirm = vi.fn(async () => {
    order.push("confirm");
    return opts.confirm ? opts.confirm() : "confirm-result";
  });
  return { order, submit, stage, confirm, withStage: opts.withStage ?? true };
}

describe("runPaymentSubmit — order is the contract", () => {
  it("1. submit answers { error }: outcome 'submit'; stage and confirm never called", async () => {
    const h = harness({ submit: async () => ({ error: dismissed }) });
    const outcome = await runPaymentSubmit({ submit: h.submit, stage: h.stage, confirm: h.confirm });
    expect(outcome).toEqual({ step: "submit", error: dismissed });
    expect(h.stage).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("2. submit ok: stage runs BEFORE confirm; confirm's result and the wallet pass through", async () => {
    const h = harness();
    const outcome = await runPaymentSubmit({ submit: h.submit, stage: h.stage, confirm: h.confirm });
    expect(h.order).toEqual(["submit", "stage", "confirm"]);
    expect(outcome).toEqual({
      step: "confirm",
      result: "confirm-result",
      selectedPaymentMethod: "apple_pay",
    });
  });

  it("3. stage throws: outcome 'stage' carries that error; confirm never called", async () => {
    const thrown = new Error("Could not prepare your booking. You have not been charged.");
    const h = harness({
      stage: async () => {
        throw thrown;
      },
    });
    const outcome = await runPaymentSubmit({ submit: h.submit, stage: h.stage, confirm: h.confirm });
    expect(outcome).toEqual({ step: "stage", error: thrown, selectedPaymentMethod: "apple_pay" });
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("4. no stage: confirm follows submit directly", async () => {
    const h = harness();
    const outcome = await runPaymentSubmit({ submit: h.submit, confirm: h.confirm });
    expect(h.order).toEqual(["submit", "confirm"]);
    expect(outcome.step).toBe("confirm");
  });

  it("5. submit throws: propagates; stage and confirm never called", async () => {
    const h = harness({
      submit: async () => {
        throw new Error("IntegrationError: elements.submit() ...");
      },
    });
    await expect(
      runPaymentSubmit({ submit: h.submit, stage: h.stage, confirm: h.confirm })
    ).rejects.toThrow("IntegrationError");
    expect(h.stage).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("6. confirm throws: propagates (stage already ran — today's behaviour too)", async () => {
    const h = harness({
      confirm: async () => {
        throw new Error("confirm blew up");
      },
    });
    await expect(
      runPaymentSubmit({ submit: h.submit, stage: h.stage, confirm: h.confirm })
    ).rejects.toThrow("confirm blew up");
    expect(h.order).toEqual(["submit", "stage", "confirm"]);
  });

  it("7. submit is called SYNCHRONOUSLY — before the caller's next statement (the activation-window invariant)", async () => {
    const h = harness();
    const pending = runPaymentSubmit({ submit: h.submit, stage: h.stage, confirm: h.confirm });
    // No await has happened yet: the sheet-opening call must already be in flight.
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.stage).not.toHaveBeenCalled();
    await pending;
  });

  it("carries no selectedPaymentMethod when submit returned none (card path)", async () => {
    const h = harness({ submit: async () => ({}) });
    const outcome = await runPaymentSubmit({ submit: h.submit, stage: h.stage, confirm: h.confirm });
    expect(outcome).toEqual({ step: "confirm", result: "confirm-result", selectedPaymentMethod: undefined });
  });

  it("a non-Error stage throw (string / undefined / TypeError) comes back unchanged for the caller to word", async () => {
    for (const thrown of ["nope", undefined, new TypeError("Failed to fetch")]) {
      const h = harness({
        stage: async () => {
          throw thrown;
        },
      });
      const outcome = await runPaymentSubmit({ submit: h.submit, stage: h.stage, confirm: h.confirm });
      expect(outcome.step).toBe("stage");
      if (outcome.step === "stage") expect(outcome.error).toBe(thrown);
      expect(h.confirm).not.toHaveBeenCalled();
    }
  });

  it("confirm is not called while stage is still pending (the sequencer really awaits it)", async () => {
    let releaseStage!: () => void;
    const h = harness({
      stage: () =>
        new Promise<void>((resolve) => {
          releaseStage = resolve;
        }),
    });
    const pending = runPaymentSubmit({ submit: h.submit, stage: h.stage, confirm: h.confirm });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.stage).toHaveBeenCalledTimes(1);
    expect(h.confirm).not.toHaveBeenCalled();
    releaseStage();
    const outcome = await pending;
    expect(outcome.step).toBe("confirm");
  });
});

describe("stripe-payment-form handleSubmit — the component half of the invariant", () => {
  // Test 7 pins the sequencer. This pins the caller: a future edit that adds an
  // `await` between the guards and runPaymentSubmit (a "refresh the PI" call,
  // say) would re-create the 2026-10-28 "Unable to show Apple Pay" incident.
  const source = readFileSync(
    resolve(__dirname, "../../../components/checkout/stripe-payment-form.tsx"),
    "utf8"
  );
  const start = source.indexOf("const handleSubmit = async");
  // The real call, not a comment that mentions it: the window must end at the
  // `await runPaymentSubmit(` statement itself.
  const end = source.indexOf("await runPaymentSubmit(", start);

  it("has no await between the start of handleSubmit and runPaymentSubmit", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const code = source
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments may mention the word
      .replace(/\/\/.*$/gm, ""); // so may line comments
    expect(code).not.toMatch(/\bawait\b/);
  });

  it("hands elements.submit() to the sequencer directly, with no prelude", () => {
    expect(source).toContain("submit: () => elements.submit(),");
  });
});
