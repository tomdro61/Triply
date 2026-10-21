"use client";

/**
 * The homepage Hero's extra tab (CX plan §2, §12.3): `<Hero extraTab={<ParkStayHeroTabSlot />} />`.
 * Renders nothing — on the server and for every customer — unless the
 * access hook says visible; only then is the tab's chunk (its label, form
 * and copy) fetched. The Hero renders this node twice (tab button, panel);
 * both share one access request.
 */

import dynamic from "next/dynamic";
import { useParkStayAccess } from "../use-park-stay-access";
import { SlotBoundary } from "./slot-boundary";

const LazyHeroTab = dynamic(() => import("../entry/hero-tab").then((m) => m.ParkStayHeroTab), { ssr: false, loading: () => null });

export function ParkStayHeroTabSlot() {
  const access = useParkStayAccess();
  if (access.status !== "visible") return null;
  return (
    <SlotBoundary>
      <LazyHeroTab access={access.data} />
    </SlotBoundary>
  );
}
