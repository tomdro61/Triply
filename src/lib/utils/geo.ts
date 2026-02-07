/**
 * Geographic utility functions
 */

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param lat1 - Latitude of point 1
 * @param lon1 - Longitude of point 1
 * @param lat2 - Latitude of point 2
 * @param lon2 - Longitude of point 2
 * @param round - Whether to round to 1 decimal place (default: true)
 * @returns Distance in miles
 */
export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  round: boolean = true
): number {
  const R = 3959; // Earth's radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  return round ? Math.round(distance * 10) / 10 : distance;
}

/**
 * Format distance for display
 * @param distance - Distance in miles
 * @returns Formatted string like "1.2 mi"
 */
export function formatDistance(distance: number): string {
  return `${distance.toFixed(1)} mi`;
}
