import { AirportContent } from "./types";

const contentModules: Record<string, () => Promise<{ default: AirportContent }>> = {
  JFK: () => import("./jfk"),
  LGA: () => import("./lga"),
};

/**
 * Load custom airport content if it exists.
 * Returns null for airports without custom content (template fallback).
 */
export async function getAirportContent(
  airportCode: string
): Promise<AirportContent | null> {
  const loader = contentModules[airportCode.toUpperCase()];
  if (!loader) return null;

  const mod = await loader();
  return mod.default;
}
