import { describe, expect, it, vi } from "vitest";
import { anchorStepCard, stepAnchorTop, stepNeedsAnchor } from "../step-anchor";

function fakeWindow(opts: { scrollY: number; reducedMotion?: boolean }) {
  const scrollTo = vi.fn();
  const win = {
    scrollY: opts.scrollY,
    scrollTo,
    matchMedia: (q: string) => ({ matches: q.includes("reduce") && opts.reducedMotion === true }),
  } as unknown as Window;
  return { win, scrollTo };
}

function fakeCard(topInViewport: number): HTMLElement {
  return { getBoundingClientRect: () => ({ top: topInViewport }) } as unknown as HTMLElement;
}

describe("stepNeedsAnchor", () => {
  it("a card scrolled above the navbar line needs anchoring", () => {
    expect(stepNeedsAnchor(-420)).toBe(true);
    expect(stepNeedsAnchor(40)).toBe(true);
  });

  it("a card already sitting below the navbar is left where it is (no desktop nudge)", () => {
    expect(stepNeedsAnchor(96)).toBe(false);
    expect(stepNeedsAnchor(144)).toBe(false);
  });
});

describe("stepAnchorTop", () => {
  it("lands the card's top 96px below the viewport top", () => {
    // card is 420px above the viewport, page scrolled 1000px → card at document y 580
    expect(stepAnchorTop(-420, 1000)).toBe(484);
  });

  it("never asks for a negative scroll position", () => {
    expect(stepAnchorTop(40, 0)).toBe(0);
  });
});

describe("anchorStepCard", () => {
  it("scrolls smoothly when the card is hidden under the navbar", () => {
    const { win, scrollTo } = fakeWindow({ scrollY: 1000 });
    expect(anchorStepCard(fakeCard(-420), win)).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 484, behavior: "smooth" });
  });

  it("scrolls instantly under prefers-reduced-motion", () => {
    const { win, scrollTo } = fakeWindow({ scrollY: 1000, reducedMotion: true });
    anchorStepCard(fakeCard(-420), win);
    expect(scrollTo).toHaveBeenCalledWith({ top: 484, behavior: "auto" });
  });

  it("does nothing when the card is already in view", () => {
    const { win, scrollTo } = fakeWindow({ scrollY: 0 });
    expect(anchorStepCard(fakeCard(144), win)).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
