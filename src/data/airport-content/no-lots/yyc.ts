import type { NoLotsGuide } from ".";

// Sources (checked 2026-11-10; notes/empty-hubs-2026-11-10/YYC.md):
// yyc.com park, parking information, cellphone lot, public transit, taxis and
// ride-app pages; calgarytransit.com fares (live). Route 500 frequency and trip
// time are secondary-only, so neither is quoted. New rates apply to parking
// that ENDS on or after 1 Jan 2027 (so a holiday trip ending in January pays
// them already): every rate is written with that condition so it stays true;
// drop the old figures in January.
const yycNoLots: NoLotsGuide = {
  publishedOn: "2026-11-10",
  updatedOn: "2026-11-10",
  metaDescription:
    "Calgary Airport (YYC) parking guide: Economy, long-term and short-term rates (new rates for parking that ends from 1 Jan 2027), the free cellphone lot and the Route 500 bus.",

  sections: [
    {
      heading: "Calgary Airport Parking at a Glance",
      body: `Calgary International Airport's parking is all within walking distance; the airport says no shuttle is offered from any lot or parkade at this time. Daily and first-week rates for parking that **ends by 31 December 2026** (Calgary Airport Authority, November 2026; Canadian dollars, plus GST):

• **Economy lot**: **C$16 daily**, **C$80 first week**. A short walk to the Domestic terminal; availability is temporarily reduced during improvements.
• **Overheight lot**: **C$27 daily**, **C$135 first week**, with a walkway to the terminal.
• **Long-term P1 (Domestic) and P2 (International) parkades**: **C$32 daily**, **C$160 first week**. Covered, connected by skywalks; P2 also has a tunnel to International. Free EV charging on P1 levels 2 and 4.
• **Short-term P1 and P2**: first 20 minutes free, then C$5 per 20 minutes up to **C$40 daily**. Ground level, steps from the terminal.

For parking that **ends on or after 1 January 2027**, the airport lists Economy at C$18 daily (C$90 first week), Overheight at C$28 (C$140), long-term at C$35 (C$175) and short-term at C$5.50 per 20 minutes up to C$44 daily. AMA members save 20% on all parking, and booking online ahead is discounted.`,
    },
    {
      heading: "Pickups and Getting There Without Parking",
      body: `The **free cellphone waiting lot** allows up to 60 minutes. Once your guest has their bags, meet them at the Arrivals curb: Domestic between doors 4 and 7, International between doors 16 and 17.

**Route 500 Airport Express** (formerly Route 300) runs between downtown and the airport via Centre Street. An adult fare is **C$4.00** (valid 90 minutes) and a day pass is C$12.65 (Calgary Transit 2026 fares). There is no CTrain line to the airport; Route 100 connects to Saddletowne CTrain station.

**Taxis** are metered, about **C$40–45 to downtown** in normal conditions, from stands at doors 1, 9 and 15. **Airport sedans** charge a flat **C$68.75 to downtown**. **Uber and Lyft** pick up on Arrivals by doors 3, 12 or 15.`,
    },
  ],

  faqs: [
    {
      question: "How much is parking at Calgary Airport?",
      answer:
        "For parking that ends by 31 December 2026: Economy C$16 a day (C$80 for the first week), the long-term parkades C$32 a day (C$160), Overheight C$27 and short-term up to C$40 a day. For parking that ends on or after 1 January 2027: Economy C$18 (C$90), long-term C$35 (C$175), Overheight C$28 and short-term up to C$44. All plus GST.",
    },
    {
      question: "What is the lowest daily rate at YYC's own parking?",
      answer:
        "The Economy lot, a short walk to the Domestic terminal: C$16 a day (C$80 for the first week) for parking that ends by 31 December 2026, and C$18 a day (C$90) for parking that ends on or after 1 January 2027, plus GST. AMA members save 20%.",
    },
    {
      question: "Is there a shuttle from Calgary Airport parking?",
      answer:
        "No. The airport says it does not offer a shuttle from any lot or parkade at this time; all of them are within walking distance.",
    },
    {
      question: "Is there a cellphone lot at Calgary Airport?",
      answer: "Yes. It is free for up to 60 minutes, and unattended vehicles are not allowed.",
    },
    {
      question: "How do I get from YYC to downtown Calgary?",
      answer:
        "Take Route 500 Airport Express for C$4.00 (2026 fare), a metered taxi for about C$40–45, or an airport sedan for a flat C$68.75.",
    },
  ],
};

export default yycNoLots;
