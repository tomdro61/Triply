import Link from "next/link";
import type { ParkStayCard } from "@/lib/hotels/search";
import { PackagePrice } from "./package-price";
import { HotelPhoto, HotelRatingLine, RoomTimesLine, ShuttleLine } from "./hotel-facts";

/** One results card: the hotel, its OWN lot, the leading room, and the all-in price (plan v3 §8.2). */
export function OfferCard({ card, returnDate, searchQuery, airport }: { card: ParkStayCard; returnDate: string; searchQuery: string; airport: string }) {
  const q = new URLSearchParams(searchQuery);
  q.set("seen", String(card.room.price.headlineTotalCents));
  const href = `/park-stay/${airport.toLowerCase()}/${card.hotelKey}?${q.toString()}`;
  return (
    <article className="grid grid-cols-1 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-[200px_1fr_auto]">
      <HotelPhoto url={card.photoUrl} name={card.name} />
      <div className="space-y-1">
        <h2 className="font-heading text-lg font-bold">
          <Link href={href} className="hover:underline">
            {card.name}
          </Link>
        </h2>
        <HotelRatingLine stars={card.stars} rating={card.rating} reviewCount={card.reviewCount} />
        {card.address && <p className="text-xs text-muted-foreground">{card.address}</p>}
        <p className="text-sm">Parking at the hotel: {card.lot.name}</p>
        <ShuttleLine lot={card.lot} />
        <RoomTimesLine lot={card.lot} />
        <p className="text-sm">
          {card.room.roomName}
          {card.room.boardName ? ` · ${card.room.boardName}` : ""}
        </p>
        <p className="text-xs text-muted-foreground">{card.room.refundabilitySummary}</p>
      </div>
      <div className="flex flex-col items-end justify-between gap-3">
        <PackagePrice price={card.room.price} returnDate={returnDate} />
        <Link href={href} className="text-sm font-medium text-primary hover:underline">
          See rooms
        </Link>
      </div>
    </article>
  );
}
