import { isValidMintySiteId } from "@/lib/privacy/inline-analytics-scripts";

/**
 * Minty Recover pilot switch. The pixel, its CSP entries (next.config.mjs) and
 * the privacy / cookie copy that names Minty all key off this one env var, so
 * with it unset the site behaves exactly as before. A malformed value counts
 * as unset rather than loading a broken script.
 */
const raw = process.env.NEXT_PUBLIC_MINTY_SITE_ID?.trim();

export const MINTY_SITE_ID: string | null = isValidMintySiteId(raw) ? raw : null;

export const MINTY_ENABLED = MINTY_SITE_ID !== null;
