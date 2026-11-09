import { isMintySkipPath, isValidMintySiteId } from "@/lib/privacy/inline-analytics-scripts";

/**
 * Minty Recover pilot switch. The pixel, its CSP entries (next.config.mjs) and
 * the privacy / cookie copy that names Minty all key off this one env var, so
 * with it unset the site behaves exactly as before. A malformed value counts
 * as unset rather than loading a broken script.
 */
const raw = process.env.NEXT_PUBLIC_MINTY_SITE_ID?.trim();

export const MINTY_SITE_ID: string | null = isValidMintySiteId(raw) ? raw : null;

export const MINTY_ENABLED = MINTY_SITE_ID !== null;

/** The loader tags its script with id="AddShoppers" (see mintyInitScript). */
export function isMintyLoaded(): boolean {
  return typeof document !== "undefined" && document.getElementById("AddShoppers") !== null;
}

/**
 * A loaded widget cannot be unloaded, so the only way to keep it off a
 * checkout / confirmation / account page (or off the site after an analytics
 * opt-out) is a full page load, where the loader's own rules skip it. Returns
 * true when it started one.
 */
export function reloadToDropMinty(pathname: string | null, force = false): boolean {
  if (!MINTY_ENABLED || !isMintyLoaded()) return false;
  if (!force && !(pathname && isMintySkipPath(pathname))) return false;
  // This page is thrown away: silence GA on it so the checkout funnel events
  // its effects fire (checkout_open, checkout_step_view…) are counted once,
  // by the reloaded page, not twice. Called from a layout effect, which runs
  // before any page's passive effects in the same commit.
  window.gtag = () => {};
  window.location.reload();
  return true;
}
