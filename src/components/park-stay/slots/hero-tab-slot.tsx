"use client";

/**
 * The homepage Hero's extra tab (CX plan §2, §12.3): `<Hero extraTab={<ParkStayHeroTabSlot />} />`.
 * Renders nothing — on the server and for every customer — unless the
 * access hook says visible; only then is the tab's chunk (its label, form
 * and copy) fetched.
 *
 * ONE owner (review of PR B, item 1): the Hero renders this node once; it
 * reads the access answer once and the lazy tab portals its panel into the
 * Hero's content area, so the panel never asks on its own. Whenever the
 * answer stops being visible, or the lazy tab fails, it resets the Hero to
 * the parking tab — the Park & Stay tab is never left active over an empty
 * panel.
 */

import dynamic from "next/dynamic";
import { useCallback, useContext, useEffect, useState } from "react";
import { HeroExtraTabContext } from "@/components/shared/hero-extra-tab";
import { useParkStayAccess, type ParkStayAccessState } from "../use-park-stay-access";
import { SlotBoundary } from "./slot-boundary";

const LazyHeroTab = dynamic(() => import("../entry/hero-tab").then((m) => m.ParkStayHeroTab), { ssr: false, loading: () => null });

export type HeroTabDecision = "show" | "hidden" | "reset";

/**
 * "show": the tab (and, while active, its form). "hidden": nothing, and the
 * Hero is not on this tab. "reset": nothing can be shown but the Hero IS on
 * this tab — it must go back to Parking.
 */
export function heroTabDecision(input: { access: ParkStayAccessState["status"]; active: boolean; failed: boolean }): HeroTabDecision {
  if (input.access === "visible" && !input.failed) return "show";
  return input.active ? "reset" : "hidden";
}

export function ParkStayHeroTabSlot() {
  const access = useParkStayAccess();
  const ctx = useContext(HeroExtraTabContext);
  const [failed, setFailed] = useState(false);
  const onError = useCallback(() => setFailed(true), []);
  const decision = heroTabDecision({ access: access.status, active: ctx?.active ?? false, failed });
  const unavailable = ctx?.unavailable;

  useEffect(() => {
    if (decision === "reset") unavailable?.();
  }, [decision, unavailable]);

  if (decision !== "show" || access.status !== "visible") return null;
  return (
    <SlotBoundary onError={onError}>
      <LazyHeroTab access={access.data} />
    </SlotBoundary>
  );
}
