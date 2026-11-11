import type { NoLotsGuide } from ".";

// Sources (checked 2026-11-10; notes/empty-hubs-2026-11-10/YOW.md):
// yow.ca parking, special offers and ground transportation pages (live).
// OC Transpo fares and O-Train frequency could not be opened (403), so none
// are quoted. Rates change 1 Jan 2027: every rate is written as "until 31
// December 2026 … from 1 January 2027 …" so it stays true; drop the old
// figures in January.
const yowNoLots: NoLotsGuide = {
  publishedOn: "2026-11-10",
  updatedOn: "2026-11-10",
  metaDescription:
    "Ottawa Airport (YOW) parking guide: P4 long-term and P1 parkade rates (new rates from 1 Jan 2027), the airport's discounts, the free cell phone lot, O-Train Line 4 and route 105.",

  sections: [
    {
      heading: "Ottawa Airport Parking at a Glance",
      body: `Ottawa Macdonald–Cartier International Airport runs two public parking areas, both a walk from the terminal. Rates until 31 December 2026 (Ottawa International Airport Authority, November 2026; prices in Canadian dollars):

• **P4 Long-term / Overheight lot**: C$6 per 30 minutes up to **C$21 per 24 hours**, **C$105 per 7 days** or **C$210 per 30 days**. Uncovered, about a 7-minute walk, 3.6 m height limit.
• **P1 Parkade**: C$6 per 30 minutes up to **C$26 per 24 hours**. Covered, about a 2-minute walk over two skywalks, with free EV charging (120V). No weekly rate is published.

From **1 January 2027** the airport has announced P1 at C$28 per 24 hours and P4 at C$22 per 24 hours (C$110 per 7 days, C$220 per 30 days), billed per 20 minutes.

The parking office (P1 level 1) gives free battery boosts and snow dig-outs around the clock.`,
    },
    {
      heading: "Ways to Pay Less",
      body: `The airport's own offers (not combinable):
• **"10 for 30"** in P4: book a 14–30 day stay online and pay for 10 days
• **CAA members**: 20% off online bookings, 10% off at the pay station
• **CFOne card holders**: 15% off
• **Visa Infinite Privilege**: 20% off in P1 (not online)`,
    },
    {
      heading: "Pickups and Getting There Without Parking",
      body: `The **free cell phone lot** is 30–45 seconds' drive from the Arrivals curb: from Airport Parkway turn right at the lights onto Air Cargo Private; it is the first lot on the right. Drivers must stay with the car. Pick up at the Arrivals curb (pillars 1–3 suggested) and drop off at Level 3 Departures.

**O-Train Line 4** runs from Airport station, connected to Level 3 of the terminal, to South Keys from 6:00 a.m. to midnight. **Bus route 105** runs 24 hours a day, every 30 minutes, from the Level 3 Departures roadway. Taxis queue at Level 1 Arrivals; rideshare pick-up is at pillars 12 and 13 on Level 1.`,
    },
  ],

  faqs: [
    {
      question: "How much is parking at Ottawa Airport?",
      answer:
        "Until 31 December 2026, the P4 long-term lot is C$21 per 24 hours (C$105 per week) and the covered P1 parkade is C$26 per 24 hours. From 1 January 2027 the airport has announced C$22 (C$110 per week) for P4 and C$28 for P1.",
    },
    {
      question: "What is the lowest long-term rate at YOW's own parking?",
      answer:
        "P4: C$105 per 7 days or C$210 per 30 days until 31 December 2026, and C$110 or C$220 from 1 January 2027. Booking a 14–30 day stay online with the airport's \"10 for 30\" offer charges only 10 days.",
    },
    {
      question: "Is there covered parking at Ottawa Airport?",
      answer: "Yes. The P1 parkade is covered and about a 2-minute walk to the terminal over two skywalks.",
    },
    {
      question: "Is there a cell phone lot at YOW?",
      answer:
        "Yes, a free one 30–45 seconds from the Arrivals curb, off Air Cargo Private. Drivers must stay with their vehicle.",
    },
    {
      question: "Can I take transit to Ottawa Airport?",
      answer:
        "Yes. O-Train Line 4 runs from the terminal to South Keys from 6:00 a.m. to midnight, and bus route 105 runs 24 hours a day, every 30 minutes.",
    },
  ],
};

export default yowNoLots;
