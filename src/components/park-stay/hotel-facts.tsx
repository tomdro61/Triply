/**
 * Shared Park & Stay display pieces (mockup screens 7 and 8): the photo, the
 * score badge, the meta line, icon fact rows and tags. The hotel's own lot
 * is described as ResLab describes it (plan v3 §8.2–8.3): shuttle hours come
 * from ResLab, not LiteAPI facility ids. Null fields are omitted.
 */

import Image from "next/image";
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { PARK_STAY_TAX_PENDING_NOTE } from "@/lib/pricing/copy";
import { ratingLabel, type MetaPart, type RoomTag } from "./card-facts";

export function HotelPhoto({ url, name, sizes = "(max-width: 640px) 100vw, 240px", eager = false, children }: { url: string | null; name: string; sizes?: string; eager?: boolean; children?: ReactNode }) {
  return (
    <div className="relative h-full min-h-36 w-full overflow-hidden bg-gray-100">
      {url ? (
        <Image src={url} alt={name} fill sizes={sizes} className="object-cover" loading={eager ? "eager" : "lazy"} />
      ) : (
        <div className="flex h-full min-h-36 w-full items-center justify-center text-xs text-gray-400" aria-label={`${name} (no photo)`}>
          No photo
        </div>
      )}
      {children}
    </div>
  );
}

/** The score on the photo: "8.4 Very good" (the word only from the fixed mapping). Nothing when there is no score. */
export function ScoreBadge({ rating, className = "absolute left-2 top-2" }: { rating: number | null; className?: string }) {
  if (rating === null || !(rating > 0)) return null;
  const word = ratingLabel(rating);
  return (
    <span className={`${className} rounded-lg bg-navy px-2 py-0.5 font-heading text-[13px] font-bold text-white`}>
      {rating.toFixed(1)}
      {word && <small className="ml-1 text-[11px] font-medium opacity-85">{word}</small>}
    </span>
  );
}

export function MetaLine({ parts, className = "" }: { parts: MetaPart[]; className?: string }) {
  if (parts.length === 0) return null;
  return (
    <p className={`text-xs text-muted-foreground ${className}`}>
      {parts.map((p, i) => (
        <span key={p.text}>
          {i > 0 && " · "}
          {p.label ? (
            <>
              <span aria-hidden="true">{p.text}</span>
              <span className="sr-only">{p.label}</span>
            </>
          ) : (
            p.text
          )}
        </span>
      ))}
    </p>
  );
}

/** One icon fact row: a small tinted icon tile, then the text (a bold lead word where given). */
export function FactRow({ icon, lead, children }: { icon: ReactNode; lead?: string; children?: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="inline-flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-700" aria-hidden="true">
        {icon}
      </span>
      <span className="pt-0.5">
        {lead && <b className="font-semibold text-gray-900">{lead}</b>}
        {lead && children ? " " : null}
        {children}
      </span>
    </li>
  );
}

const TONE: Record<RoomTag["tone"], string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
  no: "border-gray-200 bg-gray-50 text-gray-500",
  warn: "border-amber-300 bg-amber-50 text-amber-900",
};

export function Tags({ tags, compact = false }: { tags: RoomTag[]; compact?: boolean }) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((t) => (
        <span key={t.text} className={`inline-flex items-center gap-1 rounded-full border font-semibold ${compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-0.5 text-xs"} ${TONE[t.tone]}`}>
          {t.tone === "ok" && <Check className="h-3 w-3" aria-hidden="true" />}
          {t.text}
        </span>
      ))}
    </div>
  );
}

/** Said ONCE per page (not on every card): sandbox prices, and the hotel tax rules still pending (M16). */
export function PreviewBanner() {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {PARK_STAY_TAX_PENDING_NOTE}. Sandbox prices, not bookable.
    </div>
  );
}
