import { AirportContent } from "../types";

// Sources (checked 2026-11-10; notes/empty-hubs-2026-11-10/RSW.md):
// flylcpa.com parking, RSWRemote, cell phone lots, public transport, ride app
// and FAQ pages (all live). LeeTran's fare and Route 50 frequency could not be
// confirmed, so neither is quoted. The RSWRemote lot runs 23–29 Nov 2026 only:
// remove that section after 29 Nov 2026.
const rswNoLots: AirportContent = {
  publishedOn: "2026-11-10",
  updatedOn: "2026-11-10",
  metaDescription:
    "Southwest Florida International (RSW) parking guide: long-term lot $14/day with a free shuttle, garage $28/day, the Thanksgiving remote lot, cell phone lots and the LeeTran bus.",

  sections: [
    {
      heading: "Fort Myers Airport Parking at a Glance",
      body: `Southwest Florida International Airport (RSW) is southeast of Fort Myers, about three miles east of I-75 at exit 128. It runs two parking areas year-round, both open 24/7 with no reservation needed. Rates include all taxes and fees (Lee County Port Authority, October 2026):

• **Long-term Parking**: $2/hour, **$14 daily maximum**. A surface lot with a free door-to-door shuttle from your car to the terminal curb; drivers help with luggage.
• **Short-term Parking (garage)**: first 20 minutes free, then $4/hour, **$28 daily maximum**. Directly across from the terminal; level 2 is covered (8'4" height limit) and level 3 is open air.

No weekly rate is published. Exit lanes take cash, major cards, Apple Pay and Google Pay. Cars left more than 60 days may be towed.`,
    },
    {
      heading: "Thanksgiving: the RSWRemote Lot",
      body: `For Thanksgiving week the airport opens **RSWRemote**, a holiday overflow lot on the north side of the airport (11861 Regional Lane, off Daniels Parkway at I-75 exit 131). It runs **Monday, November 23 to Sunday, November 29, 2026**, costs a flat **$60**, and must be reserved and prepaid at rswremoteparking.com (non-refundable). Shuttles run to the terminal curb; allow an extra 30 minutes.`,
    },
    {
      heading: "Pickups and Getting There Without Parking",
      body: `RSW has two **cell phone lots**: Lot 1 at Airport Plaza off Terminal Access Road, about two minutes from the curb, and an overflow Lot 2 on Air Cargo Lane. Pick up arriving passengers at the lower-level curb; unattended cars at the curb are towed.

**Uber and Lyft** pick up on the arrivals level. **LeeTran Route 50** stops on the lower level of the parking garage (Stop 3) and connects at Daniels Parkway and U.S. 41 to the rest of LeeTran. It runs 7:32 a.m.–9:54 p.m. Monday to Saturday and 8:19 a.m.–7:00 p.m. Sunday; times change seasonally.`,
    },
  ],

  faqs: [
    {
      question: "How much is parking at RSW?",
      answer:
        "The short-term garage is $4 an hour with a $28 daily maximum. The long-term surface lot is $2 an hour with a $14 daily maximum. Rates include all taxes and fees.",
    },
    {
      question: "What is the cheapest parking at Fort Myers airport?",
      answer:
        "The long-term lot at $14 a day. A free shuttle runs from your car to the terminal curb, and drivers help with luggage.",
    },
    {
      question: "Do I need a reservation to park at RSW?",
      answer:
        "No, not for the garage or the long-term lot. Both are open 24/7. Only the Thanksgiving RSWRemote lot (November 23–29, 2026, $60 flat) has to be booked and prepaid.",
    },
    {
      question: "Is there covered parking at RSW?",
      answer: "Yes. Level 2 of the short-term garage, across from the terminal, is covered (8'4\" height limit). Level 3 is open air.",
    },
    {
      question: "Is there a cell phone lot at RSW?",
      answer:
        "Yes, two. Lot 1 is at Airport Plaza off Terminal Access Road, about two minutes from the curb. Lot 2 is on Air Cargo Lane.",
    },
    {
      question: "Can I take a bus to RSW?",
      answer:
        "Yes. LeeTran Route 50 stops on the lower level of the parking garage (Stop 3) and connects at Daniels Parkway and U.S. 41.",
    },
  ],
};

export default rswNoLots;
