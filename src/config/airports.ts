export interface Airport {
  code: string;
  name: string;
  city: string;
  state: string;
  country?: string;
  timezone: string;
  latitude: number;
  longitude: number;
  slug: string;
  enabled: boolean;
  isTest?: boolean; // Flag for test locations
  reslabLocationId?: number; // Direct mapping to ResLab location ID
}

export const airports: Airport[] = [
  // ==========================================================================
  // Production Airports (NYC)
  // ==========================================================================
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
    longitude: -73.874,
    slug: "new-york-lga",
    enabled: true,
  },

  // ==========================================================================
  // Test Locations (ResLab Sandbox)
  // TODO: When production ResLab API key is received:
  //   1. Set enabled: false on all TEST-* airports below
  //   2. Verify JFK/LGA return real inventory from ResLab
  //   3. Update the default airport in the homepage search component
  // ==========================================================================
  {
    code: "TEST-NY",
    name: "Beacon Test Airport (TEST)",
    city: "Beacon",
    state: "NY",
    timezone: "America/New_York",
    latitude: 41.5048158,
    longitude: -73.9695832,
    slug: "beacon-test",
    enabled: true,
    isTest: true,
    reslabLocationId: 195,
  },
  {
    code: "TEST-OH",
    name: "Cincinnati Test Airport (TEST)",
    city: "Cincinnati",
    state: "OH",
    timezone: "America/New_York",
    latitude: 39.1031182,
    longitude: -84.5120196,
    slug: "cincinnati-test",
    enabled: true,
    isTest: true,
    reslabLocationId: 194,
  },
  {
    code: "TEST-CA",
    name: "Albany CA Test Airport (TEST)",
    city: "Albany",
    state: "CA",
    timezone: "America/Los_Angeles",
    latitude: 35.125801,
    longitude: -117.9859038,
    slug: "albany-ca-test",
    enabled: true,
    isTest: true,
    reslabLocationId: 197,
  },
  {
    code: "TEST-QC",
    name: "Montreal Test Airport (TEST)",
    city: "Montreal",
    state: "QC",
    country: "Canada",
    timezone: "America/New_York",
    latitude: 45.5016889,
    longitude: -73.567256,
    slug: "montreal-test",
    enabled: true,
    isTest: true,
    reslabLocationId: 196,
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

// Production airports only (excludes test locations)
export const productionAirports = airports.filter(
  (a) => a.enabled && !a.isTest
);

// Test airports only
export const testAirports = airports.filter((a) => a.enabled && a.isTest);

export function getAirportByCode(code: string): Airport | undefined {
  return airportsByCode[code.toUpperCase()];
}

export function getAirportBySlug(slug: string): Airport | undefined {
  return airportsBySlug[slug.toLowerCase()];
}

export function getAirportByReslabLocationId(
  locationId: number
): Airport | undefined {
  return airports.find((a) => a.reslabLocationId === locationId);
}
