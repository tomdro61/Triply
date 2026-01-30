import { UnifiedLot } from "@/types/lot";

// Mock data for development - will be replaced with Reservations Lab API
export const mockLots: UnifiedLot[] = [
  {
    id: "jfk-1",
    source: "reslab",
    sourceId: "reslab-jfk-1",
    name: "JFK Long Term Parking",
    slug: "jfk-long-term-parking",
    address: "123 Airport Blvd",
    city: "Jamaica",
    state: "NY",
    zipCode: "11430",
    latitude: 40.6501,
    longitude: -73.7856,
    description:
      "Experience premium service at JFK Long Term Parking. Located just minutes from the terminal, we offer secure, monitored facilities with 24/7 shuttle service. Whether you're traveling for business or leisure, our dedicated staff ensures a seamless start and end to your journey. Our facility features well-lit spaces, security patrols, and complimentary shuttles running every 10-15 minutes.",
    directions:
      "From the Van Wyck Expressway, take exit 1 toward JFK Airport. Turn right onto Airport Blvd. Our facility is on the left, 0.5 miles before the terminal entrance. Look for the blue JFK Long Term Parking sign.",
    shuttleInfo: {
      summary: "Free 24/7 shuttle to all JFK terminals",
      details:
        "Shuttles run every 10-15 minutes. Average ride time is 5 minutes. Shuttles are wheelchair accessible.",
      frequency: "Every 10-15 minutes",
      operatingHours: "24/7",
    },
    amenities: [
      { id: 1, name: "shuttle", displayName: "Free Shuttle" },
      { id: 2, name: "outdoor", displayName: "Outdoor Self-Park" },
      { id: 3, name: "security", displayName: "24/7 Security" },
      { id: 4, name: "cctv", displayName: "CCTV Surveillance" },
      { id: 5, name: "lighting", displayName: "Well-Lit Facility" },
    ],
    photos: [
      {
        id: "1",
        url: "https://images.unsplash.com/photo-1506521781263-d8422e82f27a?w=800",
        alt: "Parking lot exterior",
      },
      {
        id: "2",
        url: "https://images.unsplash.com/photo-1573348722427-f1d6819fdf98?w=800",
        alt: "Parking facility",
      },
    ],
    rating: 4.7,
    reviewCount: 1248,
    distanceFromAirport: 0.8,
    pricing: {
      minPrice: 12,
      maxPrice: 18,
      currency: "USD",
      parkingTypes: [
        {
          id: 1,
          name: "Outdoor Self-Park",
          price: 12,
          originalPrice: 15,
        },
      ],
    },
    availability: "available",
  },
  {
    id: "jfk-2",
    source: "reslab",
    sourceId: "reslab-jfk-2",
    name: "Quick Park JFK",
    slug: "quick-park-jfk",
    address: "456 Van Wyck Expressway",
    city: "Jamaica",
    state: "NY",
    zipCode: "11430",
    latitude: 40.6612,
    longitude: -73.7729,
    description:
      "Quick Park JFK offers premium covered parking with valet service available. Our state-of-the-art facility provides EV charging stations, climate-controlled waiting area, and express shuttles to all terminals. Perfect for business travelers who value convenience and premium service.",
    directions:
      "Located directly on Van Wyck Expressway, 1.2 miles from JFK terminals. Take exit 2 and our facility is immediately on your right.",
    shuttleInfo: {
      summary: "Complimentary shuttle service to all terminals",
      details:
        "Express shuttles run every 5-10 minutes during peak hours. Climate-controlled vehicles with luggage assistance.",
      frequency: "Every 5-10 minutes",
      operatingHours: "24/7",
    },
    amenities: [
      { id: 1, name: "shuttle", displayName: "Free Shuttle" },
      { id: 2, name: "covered", displayName: "Covered Self-Park" },
      { id: 3, name: "valet", displayName: "Valet Available" },
      { id: 4, name: "ev", displayName: "EV Charging" },
      { id: 5, name: "wifi", displayName: "Free WiFi" },
      { id: 6, name: "lounge", displayName: "Waiting Lounge" },
    ],
    photos: [
      {
        id: "1",
        url: "https://images.unsplash.com/photo-1573348722427-f1d6819fdf98?w=800",
        alt: "Covered parking garage",
      },
    ],
    rating: 4.9,
    reviewCount: 892,
    distanceFromAirport: 1.2,
    pricing: {
      minPrice: 18,
      maxPrice: 28,
      currency: "USD",
      parkingTypes: [
        {
          id: 1,
          name: "Covered Self-Park",
          price: 18,
          originalPrice: 22,
        },
        {
          id: 2,
          name: "Valet Parking",
          price: 28,
        },
      ],
    },
    availability: "available",
  },
  {
    id: "jfk-3",
    source: "reslab",
    sourceId: "reslab-jfk-3",
    name: "Economy Airport Parking",
    slug: "economy-airport-parking-jfk",
    address: "789 Rockaway Blvd",
    city: "South Ozone Park",
    state: "NY",
    zipCode: "11420",
    latitude: 40.6723,
    longitude: -73.8012,
    description:
      "Budget-friendly outdoor parking with reliable shuttle service. A great option for long-term parking needs. Our no-frills approach means lower prices without sacrificing security or convenience.",
    directions:
      "From Belt Parkway, exit at Rockaway Blvd. Head north for 0.5 miles. Facility is on the right side.",
    shuttleInfo: {
      summary: "Free shuttle to terminals",
      details: "Shuttles run every 15-20 minutes from 5AM to midnight.",
      frequency: "Every 15-20 minutes",
      operatingHours: "5AM - 12AM",
    },
    amenities: [
      { id: 1, name: "shuttle", displayName: "Free Shuttle" },
      { id: 2, name: "outdoor", displayName: "Outdoor Self-Park" },
      { id: 3, name: "security", displayName: "Security Patrols" },
    ],
    photos: [
      {
        id: "1",
        url: "https://images.unsplash.com/photo-1590674899484-d5640e854abe?w=800",
        alt: "Outdoor parking lot",
      },
    ],
    rating: 4.3,
    reviewCount: 567,
    distanceFromAirport: 2.1,
    pricing: {
      minPrice: 8,
      maxPrice: 8,
      currency: "USD",
      parkingTypes: [
        {
          id: 1,
          name: "Outdoor Self-Park",
          price: 8,
          originalPrice: 10,
        },
      ],
    },
    availability: "available",
  },
  {
    id: "jfk-4",
    source: "reslab",
    sourceId: "reslab-jfk-4",
    name: "Premium Valet JFK",
    slug: "premium-valet-jfk",
    address: "321 Federal Circle",
    city: "Jamaica",
    state: "NY",
    zipCode: "11430",
    latitude: 40.6455,
    longitude: -73.7901,
    description:
      "Full-service valet parking with car wash and detailing options available. Experience the ultimate in convenience - simply drive up to the terminal, hand over your keys, and we take care of the rest. Perfect for travelers who want a stress-free airport experience.",
    directions:
      "Meet our valet attendants at the terminal departure level. Look for Premium Valet JFK signs at the curb.",
    shuttleInfo: {
      summary: "Door-to-door valet service",
      details:
        "No shuttle needed! Meet our valet at the terminal curb for drop-off and pick-up.",
    },
    amenities: [
      { id: 1, name: "valet", displayName: "Valet Service" },
      { id: 2, name: "covered", displayName: "Covered Parking" },
      { id: 3, name: "carwash", displayName: "Car Wash" },
      { id: 4, name: "detail", displayName: "Detailing Available" },
      { id: 5, name: "inspection", displayName: "Vehicle Inspection" },
    ],
    photos: [
      {
        id: "1",
        url: "https://images.unsplash.com/photo-1486006920555-c77dcf18193c?w=800",
        alt: "Valet parking entrance",
      },
    ],
    rating: 4.8,
    reviewCount: 423,
    distanceFromAirport: 0.5,
    pricing: {
      minPrice: 32,
      maxPrice: 45,
      currency: "USD",
      parkingTypes: [
        {
          id: 1,
          name: "Valet Parking",
          price: 32,
        },
        {
          id: 2,
          name: "Valet + Car Wash",
          price: 45,
        },
      ],
    },
    availability: "limited",
  },
  {
    id: "lga-1",
    source: "reslab",
    sourceId: "reslab-lga-1",
    name: "LaGuardia Express Parking",
    slug: "laguardia-express-parking",
    address: "100 Ditmars Blvd",
    city: "East Elmhurst",
    state: "NY",
    zipCode: "11369",
    latitude: 40.7812,
    longitude: -73.8789,
    description:
      "Quick and convenient parking near LaGuardia Airport. Our facility offers easy access to all terminals with frequent shuttle service. Great for domestic travelers looking for reliable, affordable parking.",
    directions:
      "From Grand Central Parkway, take exit 7 toward Ditmars Blvd. Our facility is 0.3 miles on the left.",
    shuttleInfo: {
      summary: "Free shuttle to all terminals",
      details:
        "Shuttles run every 10 minutes during peak hours. Average terminal arrival time: 8 minutes.",
      frequency: "Every 10 minutes",
      operatingHours: "24/7",
    },
    amenities: [
      { id: 1, name: "shuttle", displayName: "Free Shuttle" },
      { id: 2, name: "outdoor", displayName: "Outdoor Self-Park" },
      { id: 3, name: "security", displayName: "24/7 Security" },
      { id: 4, name: "luggage", displayName: "Luggage Assistance" },
    ],
    photos: [
      {
        id: "1",
        url: "https://images.unsplash.com/photo-1545179605-1296651e4e32?w=800",
        alt: "Parking facility exterior",
      },
    ],
    rating: 4.5,
    reviewCount: 756,
    distanceFromAirport: 0.9,
    pricing: {
      minPrice: 15,
      maxPrice: 15,
      currency: "USD",
      parkingTypes: [
        {
          id: 1,
          name: "Outdoor Self-Park",
          price: 15,
        },
      ],
    },
    availability: "available",
  },
  {
    id: "lga-2",
    source: "reslab",
    sourceId: "reslab-lga-2",
    name: "Park & Fly LGA",
    slug: "park-fly-lga",
    address: "200 Grand Central Pkwy",
    city: "East Elmhurst",
    state: "NY",
    zipCode: "11369",
    latitude: 40.7701,
    longitude: -73.8612,
    description:
      "Covered parking with premium amenities near LaGuardia. Features include EV charging stations, a comfortable waiting area, and fast shuttle service. Ideal for travelers who want protected parking for their vehicle.",
    directions:
      "Located on Grand Central Parkway service road, 1.5 miles from LGA terminals. Take exit 6 and follow signs to Park & Fly.",
    shuttleInfo: {
      summary: "Complimentary shuttle service",
      details:
        "Fast and frequent shuttles to all terminals. Dedicated shuttle lane for quick boarding.",
      frequency: "Every 8-12 minutes",
      operatingHours: "24/7",
    },
    amenities: [
      { id: 1, name: "shuttle", displayName: "Free Shuttle" },
      { id: 2, name: "covered", displayName: "Covered Parking" },
      { id: 3, name: "ev", displayName: "EV Charging" },
      { id: 4, name: "wifi", displayName: "Free WiFi" },
      { id: 5, name: "coffee", displayName: "Complimentary Coffee" },
    ],
    photos: [
      {
        id: "1",
        url: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800",
        alt: "Modern parking garage",
      },
    ],
    rating: 4.6,
    reviewCount: 512,
    distanceFromAirport: 1.5,
    pricing: {
      minPrice: 22,
      maxPrice: 22,
      currency: "USD",
      parkingTypes: [
        {
          id: 1,
          name: "Covered Self-Park",
          price: 22,
          originalPrice: 26,
        },
      ],
    },
    availability: "available",
  },
];

// Helper functions
export function getLotById(id: string): UnifiedLot | undefined {
  return mockLots.find((lot) => lot.id === id || lot.slug === id);
}

export function getLotsByAirport(airportCode: string): UnifiedLot[] {
  const prefix = airportCode.toLowerCase();
  return mockLots.filter((lot) => lot.id.toLowerCase().startsWith(prefix));
}

export function sortLots(lots: UnifiedLot[], sortBy: string): UnifiedLot[] {
  const sorted = [...lots];
  switch (sortBy) {
    case "price_asc":
      sorted.sort(
        (a, b) => (a.pricing?.minPrice ?? 0) - (b.pricing?.minPrice ?? 0)
      );
      break;
    case "price_desc":
      sorted.sort(
        (a, b) => (b.pricing?.minPrice ?? 0) - (a.pricing?.minPrice ?? 0)
      );
      break;
    case "rating":
      sorted.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
      break;
    case "distance":
      sorted.sort(
        (a, b) =>
          (a.distanceFromAirport ?? 999) - (b.distanceFromAirport ?? 999)
      );
      break;
    case "popularity":
    default:
      sorted.sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0));
      break;
  }
  return sorted;
}
