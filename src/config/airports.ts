export interface Airport {
  code: string;
  name: string;
  city: string;
  state: string;
  timezone: string;
  latitude: number;
  longitude: number;
  slug: string;
  enabled: boolean;
}

export const airports: Airport[] = [
  {
    code: "JFK",
    name: "John F. Kennedy International Airport",
    city: "New York",
    state: "NY",
    timezone: "America/New_York",
    latitude: 40.6413,
    longitude: -73.7781,
    slug: "new-york-jfk",
    enabled: true,
  },
  {
    code: "LGA",
    name: "LaGuardia Airport",
    city: "New York",
    state: "NY",
    timezone: "America/New_York",
    latitude: 40.7769,
    longitude: -73.8740,
    slug: "new-york-lga",
    enabled: true,
  },
];

export const airportsByCode = airports.reduce(
  (acc, airport) => {
    acc[airport.code] = airport;
    return acc;
  },
  {} as Record<string, Airport>
);

export const airportsBySlug = airports.reduce(
  (acc, airport) => {
    acc[airport.slug] = airport;
    return acc;
  },
  {} as Record<string, Airport>
);

export const enabledAirports = airports.filter((a) => a.enabled);

export function getAirportByCode(code: string): Airport | undefined {
  return airportsByCode[code.toUpperCase()];
}

export function getAirportBySlug(slug: string): Airport | undefined {
  return airportsBySlug[slug.toLowerCase()];
}
