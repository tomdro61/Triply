/**
 * Where the checkout form card should sit after a step change.
 *
 * The three steps swap inside one card. On a phone, Next is tapped at the
 * bottom of a long step, so the next step opened with its first fields already
 * scrolled past (Tom, staging, 2026-10-28). After a change the card — step
 * indicator first — is anchored just under the fixed navbar, but only when it
 * has actually scrolled out from under it: on a desktop where the whole card
 * is already in view, nothing moves.
 */

/** The navbar is `fixed`; the checkout page reserves `pt-20` (80px) for it. */
export const CHECKOUT_NAVBAR_OFFSET_PX = 80;
/** Breathing room between the navbar and the card's top edge. */
export const CHECKOUT_ANCHOR_GAP_PX = 16;

/** True when the card's top is hidden under (or above) the navbar line. */
export function stepNeedsAnchor(cardTopInViewport: number): boolean {
  return cardTopInViewport < CHECKOUT_NAVBAR_OFFSET_PX + CHECKOUT_ANCHOR_GAP_PX;
}

/** Document scroll position that puts the card's top under the navbar. */
export function stepAnchorTop(cardTopInViewport: number, scrollY: number): number {
  return Math.max(0, Math.round(cardTopInViewport + scrollY - CHECKOUT_NAVBAR_OFFSET_PX - CHECKOUT_ANCHOR_GAP_PX));
}

/**
 * Scroll the window so `card` sits under the navbar. Returns whether it
 * scrolled. Smooth unless the viewer asked for reduced motion.
 */
export function anchorStepCard(card: HTMLElement, win: Window = window): boolean {
  const top = card.getBoundingClientRect().top;
  if (!stepNeedsAnchor(top)) return false;
  const reduced = typeof win.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  win.scrollTo({ top: stepAnchorTop(top, win.scrollY), behavior: reduced ? "auto" : "smooth" });
  return true;
}
