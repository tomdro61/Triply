"use client";

import Link from "next/link";
import { useId } from "react";

/**
 * Parking only | Park & Stay — ONE switch, the same on /search and
 * /park-stay (CX plan §12.1, generalising PR A's mode toggle). Two LINKS
 * with aria-current, not radio buttons: switching changes the route, so the
 * back button and screen readers treat it as navigation.
 *
 * A side that can't be offered is a disabled link (role="link",
 * aria-disabled, focusable, no href), and its reason is SHOWN beside the
 * switch and tied to it with aria-describedby (R12-M8) — so keyboard and
 * screen-reader users reach it and hear why, not only a tooltip.
 */

export type SearchMode = "parking" | "park-stay";
export type ModeSide = { href: string } | { disabledReason: string };

const BASE = "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors";

function Side({ label, side, current, reasonId }: { label: string; side: ModeSide; current: boolean; reasonId: string }) {
  if ("disabledReason" in side) {
    return (
      <span
        role="link"
        aria-disabled="true"
        tabIndex={0}
        aria-describedby={reasonId}
        title={side.disabledReason}
        className={`${BASE} cursor-not-allowed text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/40`}
      >
        {label}
      </span>
    );
  }
  return current ? (
    <Link href={side.href} aria-current="page" className={`${BASE} bg-white text-gray-900 shadow-sm`}>
      {label}
    </Link>
  ) : (
    <Link href={side.href} className={`${BASE} text-gray-600 hover:text-gray-900`}>
      {label}
    </Link>
  );
}

export function SearchModeSwitch({ mode, parking, parkStay }: { mode: SearchMode; parking: ModeSide; parkStay: ModeSide }) {
  const id = useId();
  const reasonId = `${id}-reason`;
  const reason = "disabledReason" in parking ? parking.disabledReason : "disabledReason" in parkStay ? parkStay.disabledReason : null;
  return (
    <div className="flex flex-col items-start gap-1">
      <nav aria-label="Search type" className="inline-flex rounded-full border border-gray-200 bg-gray-50 p-0.5">
        <Side label="Parking only" side={parking} current={mode === "parking"} reasonId={reasonId} />
        <Side label="Park & Stay" side={parkStay} current={mode === "park-stay"} reasonId={reasonId} />
      </nav>
      {reason !== null && (
        <p id={reasonId} className="text-xs text-gray-500">
          {reason}
        </p>
      )}
    </div>
  );
}
