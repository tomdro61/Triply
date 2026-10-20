"use client";

/**
 * Park & Stay result cards in the parking LotCard look (CX plan v2 §3):
 * photo left, the hotel and its own lot, the package price right. A NEW
 * component on purpose — LotCard fires trackSelectItem, and Park & Stay
 * sends no analytics events. The content is the old offer card's.
 */

import Image from "next/image";
import Link from "next/link";
import { MapPin } from "lucide-react";
import type { ParkStayCard } from "@/lib/hotels/search";
import { PARK_STAY_TOTAL_LABEL_INTERIM } from "@/lib/pricing/copy";
import { PackagePrice } from "./package-price";
import { HotelRatingLine, RoomTimesLine, ShuttleLine } from "./hotel-facts";
import { formatCents } from "./format";

/**
 * The hotel page link for a card: the search, the page-only flight date (so
 * "Back to results" keeps it), and the total the card showed (`seen`).
 */
export function hotelHref(airport: string, card: ParkStayCard, apiQuery: string, flight: string | null): string {
  const q = new URLSearchParams(apiQuery);
  if (flight) q.set("flight", flight);
  q.set("seen", String(card.room.price.headlineTotalCents));
  return `/park-stay/${airport.toLowerCase()}/${card.hotelKey}?${q.toString()}`;
}

export const cardElementId = (hotelKey: string) => `ps-card-${hotelKey}`;
export const mapCardElementId = (hotelKey: string) => `ps-map-card-${hotelKey}`;

function Photo({ url, name, sizes, eager }: { url: string | null; name: string; sizes: string; eager: boolean }) {
  if (!url) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-100 text-xs text-gray-400" aria-label={`${name} (no photo)`}>
        No photo
      </div>
    );
  }
  return <Image src={url} alt={name} fill className="object-cover" sizes={sizes} loading={eager ? "eager" : "lazy"} />;
}

export function ParkStayResultCard({
  card,
  href,
  returnDate,
  isHovered,
  isFocused,
  isFirst,
  onHover,
}: {
  card: ParkStayCard;
  href: string;
  returnDate: string;
  isHovered: boolean;
  /** The `focus` hotel: stays outlined while the page is open. */
  isFocused: boolean;
  isFirst: boolean;
  onHover: (key: string | null) => void;
}) {
  const ring = isHovered || isFocused ? "ring-2 ring-brand-orange border-transparent shadow-lg" : "border-gray-200 shadow-sm";
  return (
    <article
      id={cardElementId(card.hotelKey)}
      aria-current={isFocused ? "true" : undefined}
      className={`group flex scroll-mt-4 flex-col overflow-hidden rounded-xl border bg-white transition-all duration-300 hover:shadow-lg sm:flex-row ${ring}`}
      onMouseEnter={() => onHover(card.hotelKey)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="relative h-48 flex-shrink-0 sm:h-auto sm:w-48">
        <Photo url={card.photoUrl} name={card.name} sizes="(max-width: 640px) 100vw, 192px" eager={isFirst} />
      </div>
      <div className="flex flex-1 flex-col p-4">
        <div className="mb-1 flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className="text-lg font-bold leading-tight text-gray-900">
              <Link href={href} className="hover:underline">
                {card.name}
              </Link>
            </h3>
            <HotelRatingLine stars={card.stars} rating={card.rating} reviewCount={card.reviewCount} />
            {card.address && (
              <p className="flex items-center text-xs text-gray-500">
                <MapPin size={12} className="mr-1 flex-shrink-0 text-brand-blue" aria-hidden="true" />
                {card.address}
              </p>
            )}
          </div>
          <PackagePrice price={card.room.price} returnDate={returnDate} />
        </div>
        <div className="mt-2 space-y-1">
          <p className="text-sm">Parking at the hotel: {card.lot.name}</p>
          <ShuttleLine lot={card.lot} />
          <RoomTimesLine lot={card.lot} />
          <p className="text-sm">
            {card.room.roomName}
            {card.room.boardName ? ` · ${card.room.boardName}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">{card.room.refundabilitySummary}</p>
        </div>
        <div className="mt-auto flex justify-end border-t border-gray-50 pt-3">
          <Link href={href} className="rounded-lg bg-brand-orange px-4 py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-orange-600">
            See rooms
          </Link>
        </div>
      </div>
    </article>
  );
}

/** The compact card in the mobile map's snap carousel (the MobileMapCard pattern). */
export function ParkStayMapCard({ card, href }: { card: ParkStayCard; href: string }) {
  return (
    <div id={mapCardElementId(card.hotelKey)} className="w-[88vw] flex-shrink-0 snap-center overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-xl">
      <div className="flex gap-3 p-3">
        <div className="relative h-24 w-24 flex-shrink-0 overflow-hidden rounded-xl">
          <Photo url={card.photoUrl} name={card.name} sizes="96px" eager={false} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-between">
          <div>
            <h3 className="line-clamp-2 text-base font-bold leading-snug text-gray-900">{card.name}</h3>
            <p className="mt-1 truncate text-xs text-gray-500">Parking at the hotel: {card.lot.name}</p>
          </div>
          <div className="mt-1">
            <p className="text-xl font-bold text-gray-900">{formatCents(card.room.price.headlineTotalCents)}</p>
            <p className="text-[11px] text-gray-500">{PARK_STAY_TOTAL_LABEL_INTERIM}</p>
          </div>
        </div>
      </div>
      <div className="px-3 pb-3 pt-1">
        <Link href={href} className="block w-full rounded-lg bg-brand-orange py-2.5 text-center text-sm font-bold text-white">
          See rooms
        </Link>
      </div>
    </div>
  );
}
