import { createContext } from "react";

/**
 * An optional extra tab for the homepage Hero (`<Hero extraTab={node} />`).
 * The Hero renders the node TWICE, each inside this context: once in the
 * tab strip (`part: "tab"` — the node renders its tab button) and, while it
 * is the active tab, once in the content area (`part: "panel"` — the node
 * renders its form). The node owns its label and content, so nothing about
 * the tab lives in the Hero; with no `extraTab` the Hero is unchanged.
 *
 * - `select()` makes it the active tab.
 * - `unavailable()` must be called by the "tab" part when it stops showing
 *   (e.g. it unmounts): the Hero then falls back to the parking tab if the
 *   extra tab was active, so the content area is never left empty.
 */
export interface HeroExtraTabValue {
  part: "tab" | "panel";
  active: boolean;
  select: () => void;
  unavailable: () => void;
}

export const HeroExtraTabContext = createContext<HeroExtraTabValue | null>(null);
