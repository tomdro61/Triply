import Link from "next/link";

/**
 * Parking only | Park & Stay (CX plan v2 §3). Two LINKS with aria-current,
 * not radio buttons: switching changes the route, so the back button and
 * screen readers treat it as navigation. "Parking only" is disabled (not a
 * link) when the searched values can't make a parking search.
 */
export function ParkStayModeToggle({ parkingHref, currentHref }: { parkingHref: string | null; currentHref: string }) {
  const base = "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors";
  return (
    <nav aria-label="Search type" className="inline-flex rounded-full border border-gray-200 bg-gray-50 p-0.5">
      {parkingHref ? (
        <Link href={parkingHref} className={`${base} text-gray-600 hover:text-gray-900`}>
          Parking only
        </Link>
      ) : (
        <span aria-disabled="true" title="Choose your check-in and return dates first" className={`${base} cursor-not-allowed text-gray-400`}>
          Parking only
        </span>
      )}
      <Link href={currentHref} aria-current="page" className={`${base} bg-white text-gray-900 shadow-sm`}>
        Park &amp; Stay
      </Link>
    </nav>
  );
}
