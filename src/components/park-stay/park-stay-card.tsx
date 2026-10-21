"use client";

/**
 * Park & Stay result cards (mockup screen 7, approved by Tom 20 Oct 2026):
 * the photo with the score on it; the name and a muted meta line; three
 * icon fact rows (room, parking, shuttle); coloured tags for the
 * deal-breakers; a separate price column with the button. A NEW component
 * on purpose — the parking LotCard fires trackSelectItem, and Park & Stay
 * sends no analytics events. Every line comes from card-facts.ts, which
 * shows only facts we have.
 */

import Link from "next/link";
import { BedDouble, Bus, SquareParking } from "lucide-react";
import type { ParkStayCard } from "@/lib/hotels/search";
import { PARK_STAY_TOTAL_LABEL_INTERIM } from "@/lib/pricing/copy";
import { PackagePrice } from "./package-price";
import { FactRow, HotelPhoto, MetaLine, ScoreBadge, Tags } from "./hotel-facts";
import { formatCents, formatNightLabel } from "./format";
import { metaParts, milesToAirport, roomTags, shuttleFact } from "./card-facts";

/** The airport the card is shown against: its code, and its point (null = no distance shown). */
export interface CardAirport {
  code: string;
  point: { latitude: number; longitude: number } | null;
}

/** The hotel page link for a card: the search, plus the total the card showed (`seen`). */
export function hotelHref(airport: string, card: ParkStayCard, apiQuery: string): string {
  const q = new URLSearchParams(apiQuery);
  q.set("seen", String(card.room.price.headlineTotalCents));
  return `/park-stay/${airport.toLowerCase()}/${card.hotelKey}?${q.toString()}`;
}

export const cardElementId = (hotelKey: string) => `ps-card-${hotelKey}`;
export const mapCardElementId = (hotelKey: string) => `ps-map-card-${hotelKey}`;

export function ParkStayResultCard({
  card,
  href,
  airport,
  returnDate,
  isHovered,
  isFocused,
  isFirst,
  onHover,
}: {
  card: ParkStayCard;
  href: string;
  airport: CardAirport;
  returnDate: string;
  isHovered: boolean;
  /** The `focus` hotel: stays outlined while the page is open. */
  isFocused: boolean;
  isFirst: boolean;
  onHover: (key: string | null) => void;
}) {
  const ring = isHovered || isFocused ? "ring-2 ring-brand-orange border-transparent shadow-lg" : "border-gray-200 shadow-sm";
  const meta = metaParts({ stars: card.stars, miles: milesToAirport(card.lot, airport.point), airportCode: airport.code, reviewCount: card.reviewCount });
  const shuttle = shuttleFact(card.lot, airport.code);
  return (
    <article
      id={cardElementId(card.hotelKey)}
      aria-current={isFocused ? "true" : undefined}
      className={`grid scroll-mt-4 grid-cols-1 overflow-hidden rounded-xl border bg-white transition-all duration-300 hover:shadow-lg sm:grid-cols-[160px_minmax(0,1fr)] 2xl:grid-cols-[170px_minmax(0,1fr)_170px] ${ring}`}
      onMouseEnter={() => onHover(card.hotelKey)}
      onMouseLeave={() => onHover(null)}
    >
      {/* Photo: on top on a phone (16:9), the left column from sm. */}
      <div className="relative aspect-video sm:row-span-2 sm:aspect-auto 2xl:row-span-1">
        <HotelPhoto url={card.photoUrl} name={card.name} sizes="(max-width: 640px) 100vw, 170px" eager={isFirst}>
          <ScoreBadge rating={card.rating} />
        </HotelPhoto>
      </div>

      <div className="flex min-w-0 flex-col gap-2.5 p-4">
        <div>
          <h3 className="font-heading text-base font-semibold leading-tight text-gray-900">
            <Link href={href} className="hover:underline">
              {card.name}
            </Link>
          </h3>
          <MetaLine parts={meta} className="mt-0.5" />
        </div>
        <ul className="flex flex-col gap-1.5 text-[13.5px] text-gray-700">
          <FactRow icon={<BedDouble className="h-4 w-4" />} lead={card.room.roomName}>
            {card.room.boardName ? `· ${card.room.boardName}` : null}
          </FactRow>
          <FactRow icon={<SquareParking className="h-4 w-4" />} lead="Park at the hotel">
            until {formatNightLabel(returnDate)}
          </FactRow>
          <FactRow icon={<Bus className="h-4 w-4" />} lead={shuttle.lead}>
            {shuttle.rest || null}
          </FactRow>
        </ul>
        <Tags tags={roomTags(card.room)} />
      </div>

      {/* Price column: beside the details on wide lists, under them otherwise. */}
      <div className="flex items-end justify-between gap-3 border-t border-gray-100 p-4 sm:col-start-2 2xl:col-start-3 2xl:flex-col 2xl:items-end 2xl:justify-center 2xl:border-l 2xl:border-t-0">
        <PackagePrice price={card.room.price} returnDate={returnDate} align="start" />
        <Link href={href} className="whitespace-nowrap rounded-lg bg-brand-orange px-4 py-2 font-heading text-sm font-semibold text-white shadow-sm transition-colors hover:bg-orange-600">
          See rooms
        </Link>
      </div>
    </article>
  );
}

/** The compact card in the mobile map's snap carousel (the MobileMapCard pattern), with the same tags. */
export function ParkStayMapCard({ card, href }: { card: ParkStayCard; href: string }) {
  return (
    <div id={mapCardElementId(card.hotelKey)} className="w-[88vw] flex-shrink-0 snap-center overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-xl">
      <div className="flex gap-3 p-3">
        <div className="relative h-24 w-24 flex-shrink-0 overflow-hidden rounded-xl">
          <HotelPhoto url={card.photoUrl} name={card.name} sizes="96px" minHeight="">
            <ScoreBadge rating={card.rating} className="absolute left-1 top-1 !px-1.5 !text-[11px]" />
          </HotelPhoto>
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-between gap-1">
          <div>
            <h3 className="line-clamp-2 font-heading text-[15px] font-semibold leading-snug text-gray-900">{card.name}</h3>
            <p className="mt-0.5 truncate text-xs text-gray-500">
              {card.room.roomName}
              {card.room.boardName ? ` · ${card.room.boardName}` : ""}
            </p>
          </div>
          <div>
            <p className="font-heading text-xl font-bold text-gray-900">{formatCents(card.room.price.headlineTotalCents)}</p>
            <p className="text-[11px] text-gray-500">{PARK_STAY_TOTAL_LABEL_INTERIM}</p>
          </div>
        </div>
      </div>
      <div className="space-y-2 px-3 pb-3">
        <Tags tags={roomTags(card.room)} compact />
        <Link href={href} className="block w-full rounded-lg bg-brand-orange py-2.5 text-center font-heading text-sm font-semibold text-white">
          See rooms
        </Link>
      </div>
    </div>
  );
}
