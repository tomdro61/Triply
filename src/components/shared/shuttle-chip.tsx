import { Bus, X } from "lucide-react";
import type { ShuttleInfo } from "@/types/lot";
import { shuttleIsWarning, shuttleLabel, shuttleStatus } from "@/lib/lots/shuttle-status";

/**
 * The lot's shuttle as one amenity-style chip: "24/7 shuttle",
 * "Shuttle 6 AM–11:30 PM", "No shuttle" or "Shuttle suspended". Renders nothing
 * when the summary can't be read with confidence (src/lib/lots/shuttle-status.ts).
 * Styling comes from the caller, so it matches the chips beside it.
 */
export function ShuttleChip({
  shuttleInfo,
  className,
  iconSize = 12,
}: {
  shuttleInfo: ShuttleInfo | undefined;
  className: string;
  /** Match the neighbouring chips' icons (14 on the search list card). */
  iconSize?: number;
}) {
  const status = shuttleStatus(shuttleInfo?.summary);
  const label = shuttleLabel(status);
  if (!label) return null;
  return (
    <span className={className}>
      {shuttleIsWarning(status) ? (
        <X size={iconSize} aria-hidden className="text-red-500" />
      ) : (
        <Bus size={iconSize} aria-hidden className="text-green-600" />
      )}
      {label}
    </span>
  );
}
