"use client";

/**
 * The homepage Park & Stay section, between Featured Parking and the
 * comparison (CX plan §5). `page.tsx` is a Server Component, so this tiny
 * client wrapper holds the hook and the lazy import: it renders nothing on
 * the server and for every customer, and the section's chunk is fetched
 * only after the access endpoint said yes.
 */

import dynamic from "next/dynamic";
import { useParkStayAccess } from "../use-park-stay-access";
import { SlotBoundary } from "./slot-boundary";

const LazyHomeSection = dynamic(() => import("../entry/home-section").then((m) => m.ParkStayHomeSection), { ssr: false, loading: () => null });

export function ParkStayHomeSlot() {
  const access = useParkStayAccess();
  if (access.status !== "visible") return null;
  return (
    <SlotBoundary>
      <LazyHomeSection access={access.data} />
    </SlotBoundary>
  );
}
