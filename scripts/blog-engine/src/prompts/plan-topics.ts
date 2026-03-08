import { DOMAIN, BLOG_BASE_URL } from '../config.js'
import type { AirportData } from '../airport-data.js'

export function buildPlanTopicsPrompt(airportCode: string, airportData?: AirportData): string {
  const airportContext = airportData
    ? `**Airport Data Available:**
- Full name: ${airportData.fullName}
- Terminals: ${airportData.terminals.map(t => t.name).join(', ')}
- Transit: ${airportData.transit.join(', ')}
- Neighborhoods: ${airportData.neighborhoods.join(', ')}
- Roads: ${airportData.roads.join(', ')}
- Parking rates: ${airportData.parkingRates}
- Distance from city: ${airportData.distanceFromCity}
${airportData.parkingLots ? `- Off-site lots: ${airportData.parkingLots.length} lots from $${Math.min(...airportData.parkingLots.filter(l => typeof (l as Record<string,unknown>).dailyRate === 'number').map(l => (l as Record<string,unknown>).dailyRate as number))}/day` : ''}
` : `No airport data file exists yet for ${airportCode}. Generate topics based on general airport parking knowledge.\n`

  return `You are an SEO content strategist for ${DOMAIN}, an airport parking comparison website.

Generate a complete topical map (hub/sub-pillar/spoke content cluster) for **${airportCode}** airport parking.

${airportContext}

**Example: JFK Cluster Structure (use as template)**

Hub: "JFK Airport Parking: The Complete Guide (2026)"
  Sub-Pillar 1: "Off-Site JFK Parking: Compare Lots & Save Up to 70%"
    Spoke: "Cheapest JFK Airport Parking: Budget Lots Under $15/Day"
    Spoke: "JFK Long-Term Parking: Best Options for Extended Trips"
    Spoke: "JFK Parking with Shuttle: Lots with Free Airport Transfer"
  Sub-Pillar 2: "JFK Terminal Parking Guide: Rates, Maps & Tips"
    Spoke: "Terminal 4 JFK Parking: Delta Flyers' Complete Guide"
    Spoke: "JFK Economy Lot 9: Is It Worth the Savings?"
  Sub-Pillar 3: "JFK Parking Deals & Coupons (Verified 2026)"
    Spoke: "JFK Parking Promo Codes: Working Coupons This Month"
    Spoke: "JFK Parking Reservations: Book Ahead & Save"
  Sub-Pillar 4: "Getting to JFK: Parking vs Transit vs Rideshare"
    Spoke: "JFK AirTrain Parking: Park & Ride Options"
    Spoke: "Is Uber to JFK Cheaper Than Parking?"

**Rules:**
1. Hub article: 1 comprehensive guide covering ALL aspects of ${airportCode} parking
2. Sub-pillars: 4-6 detailed guides, each covering a major subtopic
3. Spokes: 2-4 focused articles per sub-pillar, targeting specific long-tail keywords
4. Every title must include the airport code "${airportCode}"
5. Assign article styles: standard, narrative, listicle, data-heavy, or comparison
6. Assign priorities: S1 (hub), S2 (sub-pillars), S3 (spokes)
7. Generate URL slugs using lowercase-hyphenated format
8. Target keywords should be realistic search terms with parking intent
9. Total: 15-25 articles per airport

Respond with ONLY valid JSON:
{
  "airportCode": "${airportCode}",
  "hub": {
    "keyword": "jfk airport parking",
    "suggestedTitle": "JFK Airport Parking: The Complete Guide (2026)",
    "slug": "jfk-airport-parking-guide",
    "articleStyle": "standard",
    "targetWords": 2500
  },
  "subPillars": [
    {
      "keyword": "off-site jfk parking",
      "suggestedTitle": "Off-Site JFK Parking: Compare Lots & Save Up to 70%",
      "slug": "jfk-off-site-parking",
      "articleStyle": "data-heavy",
      "targetWords": 1500,
      "spokes": [
        {
          "keyword": "cheapest jfk parking",
          "suggestedTitle": "Cheapest JFK Airport Parking: Budget Lots Under $15/Day",
          "slug": "cheapest-jfk-airport-parking",
          "articleStyle": "listicle",
          "targetWords": 1000
        }
      ]
    }
  ]
}`
}
