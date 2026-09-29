/**
 * Neutral box shown where a map will appear, before the map code has loaded.
 *
 * It fills its parent exactly like the real map does, so swapping it for the
 * map never moves anything on the page (CLS stays at zero). Server-renderable:
 * this is also what a visitor without JavaScript sees.
 */
export function MapPlaceholder({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`w-full h-full bg-gray-100 ${className}`}
    />
  );
}
