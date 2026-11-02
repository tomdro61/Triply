"use client";

/**
 * The homepage Park & Stay section, below Featured Parking (CX plan §5;
 * mockup screen 2). Loaded lazily by slots/home-section-slot.tsx only after
 * the access endpoint said yes. Every fact comes from the access response —
 * no supplier call, no price, no rating; each card's shuttle line is that
 * hotel's own `shuttle` field (never "free"). The look follows
 * FeaturedParking's section and cards (classes copied).
 */

import Link from "next/link";
import { Bus, ChevronRight } from "lucide-react";
import type { ParkStayAccess } from "@/lib/hotels/access";
import { HotelPhoto } from "../hotel-facts";
import { homeCards } from "./home-cards";

const POINTS: readonly { title: string; body: string }[] = [
  { title: "Room and parking, one total", body: "The night before and parking until you're back, shown as one price." },
  { title: "Shuttle to the airport", body: "Each hotel runs its own shuttle. Hours are shown before you book." },
  { title: "No early-morning rush", body: "Wake up next to the airport with your car already parked." },
];

export function ParkStayHomeSection({ access }: { access: ParkStayAccess }) {
  const cards = homeCards(access);
  if (cards.length === 0) return null;
  return (
    <section aria-labelledby="park-stay-home-heading" className="py-16 lg:py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 id="park-stay-home-heading" className="text-2xl md:text-3xl font-bold text-gray-900 mb-6">
          Park &amp; Stay: sleep at the hotel, park there, shuttle to your flight
        </h2>

        <ul className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6 mb-8">
          {POINTS.map((p) => (
            <li key={p.title} className="text-sm text-gray-500">
              <b className="block font-heading text-base font-semibold text-gray-900 mb-1">{p.title}</b>
              {p.body}
            </li>
          ))}
        </ul>

        <div className="flex gap-4 overflow-x-auto snap-x snap-mandatory pb-4 -mx-4 px-4 sm:mx-0 sm:px-0 sm:grid sm:grid-cols-2 lg:grid-cols-4 sm:gap-6 sm:overflow-visible sm:pb-0 no-scrollbar">
          {cards.map((card) => (
            <Link
              key={card.key}
              href={card.href}
              className="min-w-[280px] snap-start sm:min-w-0 bg-white rounded-xl overflow-hidden shadow-sm hover:shadow-lg transition-shadow border border-gray-100 group flex flex-col"
            >
              <div className="relative h-44 overflow-hidden">
                <HotelPhoto url={card.photoUrl} name={card.name} sizes="(max-width: 640px) 280px, 25vw" minHeight="min-h-44" />
              </div>
              <div className="p-4 flex flex-1 flex-col gap-1.5">
                <h3 className="font-bold text-gray-900 group-hover:text-brand-orange transition-colors">{card.name}</h3>
                <p className="flex items-start gap-1.5 text-xs text-gray-500">
                  <Bus size={14} className="mt-px flex-shrink-0 text-brand-blue" aria-hidden="true" />
                  <span>
                    <span className="font-semibold text-gray-700">{card.airport}</span> · {card.shuttle}
                  </span>
                </p>
                <span className="mt-auto pt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-orange">
                  See prices
                  <ChevronRight size={16} aria-hidden="true" />
                </span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
