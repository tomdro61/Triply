import { createContext } from "react";

/**
 * An optional extra tab for the homepage Hero (`<Hero extraTab={node} />`).
 * The Hero renders the node ONCE, in the tab strip, inside this context, so
 * a single owner holds whatever the tab needs (its label, its data). The
 * node renders its own tab button there and, while it is the active tab,
 * portals its panel into `panel` — an empty element the Hero puts in the
 * content area only while the tab is active (null otherwise). Nothing about
 * the tab lives in the Hero; with no `extraTab` the Hero is unchanged.
 *
 * - `select()` makes it the active tab.
 * - `unavailable()` must be called whenever the node can't show its panel
 *   (its data went away, it failed): the Hero then falls back to the parking
 *   tab if the extra tab was active, so the content area is never left
 *   empty. Both callbacks are stable.
 */
export interface HeroExtraTabValue {
  active: boolean;
  panel: HTMLElement | null;
  select: () => void;
  unavailable: () => void;
}

export const HeroExtraTabContext = createContext<HeroExtraTabValue | null>(null);
