import { DOMAIN } from '../config.js'

export function buildBootstrapPrompt(airportCode: string): string {
  return `You are generating a structured airport data file for ${DOMAIN}, an airport parking comparison website.

Generate comprehensive data for **${airportCode}** airport in the exact JSON format below. Use your knowledge to fill in as many fields as possible. For fields you're uncertain about, add "[UNVERIFIED]" to string values.

**IMPORTANT:** All URLs must be real, publicly accessible URLs. If you're not certain a URL is correct, use the placeholder "https://VERIFY_URL_NEEDED" instead.

Respond with ONLY valid JSON matching this exact structure:

{
  "code": "${airportCode}",
  "fullName": "Full official airport name",
  "lastVerified": "${new Date().toISOString().split('T')[0]}",
  "authority": "Airport authority name (e.g., Port Authority of NY & NJ)",
  "distanceFromCity": "X miles from downtown [City]",
  "parkingRates": "On-site: $XX-$XX/day, Economy: $XX/day",
  "shuttleInfo": "Description of airport shuttle services",
  "terminals": [
    {
      "name": "Terminal 1",
      "airlines": ["Airline1", "Airline2"]
    }
  ],
  "roads": ["Major Road 1", "Highway 2"],
  "transit": ["Transit option 1", "Bus route 2"],
  "neighborhoods": ["Nearby area 1", "Nearby area 2"],
  "onAirportParking": {
    "garage": {
      "name": "Main Parking Garage",
      "rate": "$XX/day",
      "spaces": "XXXX [UNVERIFIED]",
      "covered": true
    },
    "economy": {
      "name": "Economy Lot",
      "rate": "$XX/day",
      "shuttle": true
    }
  },
  "liveSources": {
    "officialParking": {
      "main": "https://official-airport-site.com/parking",
      "rates": "https://official-airport-site.com/parking/rates"
    },
    "transit": {
      "main": "https://transit-authority.com/airport"
    },
    "rideshare": {
      "uber": "https://www.uber.com/airports/${airportCode.toLowerCase()}/",
      "lyft": "https://www.lyft.com/rider/airports/${airportCode.toLowerCase()}"
    }
  },
  "emergencyContacts": {
    "police": "XXX-XXX-XXXX [UNVERIFIED]",
    "parking": "XXX-XXX-XXXX [UNVERIFIED]"
  }
}

**Guidelines:**
1. Be as specific and accurate as possible for terminal/airline assignments
2. Include ALL major terminals (not just "Terminal 1, 2, 3" — use actual names if they differ)
3. For parkingRates, provide realistic rate ranges based on the airport's market
4. For roads, list the 3-5 most important access roads/highways
5. For transit, list rail, bus, and shuttle options that connect to the airport
6. For neighborhoods, list 4-6 areas near the airport relevant to off-site parking
7. For liveSources, prioritize official .gov and authority domains
8. Mark any data point you're less than 90% confident about with [UNVERIFIED]`
}
