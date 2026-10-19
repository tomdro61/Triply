/**
 * The hotel's own lot, as ResLab describes it (plan v3 §8.2–8.3): shuttle
 * hours come from ResLab, not LiteAPI facility ids. Null fields are omitted.
 */

import Image from "next/image";
import { Bus, Clock, Star } from "lucide-react";
import type { LotDisplay } from "@/lib/hotels/hotel-lot-resolve";

export function HotelPhoto({ url, name }: { url: string | null; name: string }) {
  if (!url) {
    return (
      <div className="flex h-full min-h-32 w-full items-center justify-center rounded-md bg-muted text-xs text-muted-foreground" aria-label={`${name} (no photo)`}>
        No photo
      </div>
    );
  }
  return (
    <div className="relative h-full min-h-32 w-full overflow-hidden rounded-md bg-muted">
      <Image src={url} alt={name} fill sizes="(max-width: 640px) 100vw, 240px" className="object-cover" />
    </div>
  );
}

export function HotelRatingLine({ stars, rating, reviewCount }: { stars: number | null; rating: number | null; reviewCount: number | null }) {
  if (stars === null && rating === null) return null;
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      {stars !== null && stars > 0 && (
        <span className="flex items-center gap-0.5">
          <Star className="h-3 w-3" aria-hidden="true" /> {stars}-star
        </span>
      )}
      {rating !== null && rating > 0 && (
        <span>
          {rating.toFixed(1)}/10{reviewCount !== null && reviewCount > 0 ? ` · ${reviewCount.toLocaleString("en-US")} reviews` : ""}
        </span>
      )}
    </p>
  );
}

export function ShuttleLine({ lot, detailed = false }: { lot: LotDisplay; detailed?: boolean }) {
  return (
    <div className="text-sm">
      <p className="flex items-center gap-1">
        <Bus className="h-4 w-4" aria-hidden="true" />
        {lot.shuttleAvailable ? <span>Airport shuttle: {lot.shuttleSummary || "hours not listed"}</span> : <span>No airport shuttle</span>}
      </p>
      {detailed && lot.shuttleAvailable && lot.shuttleDetails && <p className="mt-1 text-xs text-muted-foreground">{lot.shuttleDetails}</p>}
    </div>
  );
}

export function RoomTimesLine({ lot }: { lot: LotDisplay }) {
  const parts = [
    lot.roomCheckinTime ? `Room ready from ${lot.roomCheckinTime}` : null,
    lot.roomCheckoutTime ? `check-out ${lot.roomCheckoutTime}` : null,
    lot.frontDeskHours ? `front desk ${lot.frontDeskHours}` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground">
      <Clock className="h-3 w-3" aria-hidden="true" />
      {parts.join(" · ")}
    </p>
  );
}

export function PreviewBanner() {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      Preview — sandbox prices, not bookable.
    </div>
  );
}
