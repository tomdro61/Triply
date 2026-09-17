/**
 * The persisted attribution shape as READ by reporting code and admin pages —
 * one definition instead of three hand-copied partials. No imports beyond the
 * channel enum so client components can use it without pulling in zod.
 */
import { CHANNELS, isChannel, type Channel } from "./constants-channels";

export type { Channel };
export { CHANNELS, isChannel };

export interface AttributionRow {
  channel: string | null;
  attribution: {
    v: 1 | null;
    invalid?: boolean;
    first?: { src?: string; med?: string; cmp?: string; ref?: string; land?: string; click?: string };
    last?: { src?: string; med?: string; cmp?: string; ref?: string; land?: string; click?: string };
    apt?: string;
    d?: number;
    ga_client_id?: string;
  } | null;
}

/** "unknown" = no cookie (pre-deploy, no JS); "invalid" = cookie present but
 *  unparseable (a bug — Sentry-flagged at stage time). Kept distinct from
 *  "direct" so a capture regression never reads as a traffic-mix change. An
 *  unexpected DB value for `channel` also reads as "unknown", never raw. */
export type AttributionSource = Channel | "invalid" | "unknown";

export function attributionSourceLabel(b: AttributionRow): AttributionSource {
  if (isChannel(b.channel)) return b.channel;
  if (b.attribution && b.attribution.v === null) return "invalid";
  return "unknown";
}
