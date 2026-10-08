import type { ReactNode } from "react";
import { Flame, Tag } from "lucide-react";
import type { LotBadge } from "@/types/lot";

const BADGES: Record<LotBadge, { label: string; className: string; icon: ReactNode }> = {
  most_booked: {
    label: "Most booked",
    // orange-700 text (not brand orange) for WCAG AA contrast at 11px.
    className: "bg-orange-50 text-orange-700 border-orange-200",
    icon: <Flame size={11} className="mr-1" />,
  },
  lowest_total: {
    label: "Lowest total",
    className: "bg-green-50 text-green-700 border-green-200",
    icon: <Tag size={11} className="mr-1" />,
  },
};

/** Search-result badges set server-side by searchParking (src/lib/search/ranking.ts). */
export function LotBadges({ badges, className = "" }: { badges?: LotBadge[]; className?: string }) {
  if (!badges || badges.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {badges.map((b) => (
        <span
          key={b}
          className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold ${BADGES[b].className}`}
        >
          {BADGES[b].icon}
          {BADGES[b].label}
        </span>
      ))}
    </div>
  );
}
