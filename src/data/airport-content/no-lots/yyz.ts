import type { NoLotsGuide } from ".";

// Sources (checked 2026-11-10; notes/empty-hubs-2026-11-10/YYZ.md):
// torontopearson.com parking overview, Daily Park, Value Park Garage/Lot,
// Preferred, Express, Valet Care, cell phone waiting area, ride-sharing pages;
// upexpress.com; ttc.ca fares (live). The taxi tariff and TTC 900 headway were
// not confirmed, so neither is quoted. Pearson itself calls the Value Park Lot
// (online only, varying price) its most affordable parking.
const yyzNoLots: NoLotsGuide = {
  publishedOn: "2026-11-10",
  updatedOn: "2026-11-10",
  metaDescription:
    "Toronto Pearson (YYZ) parking guide: Value Park Garage C$32/day or C$160/week, Daily Park C$42/day, valet and express rates, the free waiting areas and the UP Express.",

  sections: [
    {
      heading: "Toronto Pearson Parking at a Glance",
      body: `Toronto Pearson runs its own parking, from a value garage on the free Terminal Link train to valet at Terminal 1 (Greater Toronto Airports Authority, November 2026; prices in Canadian dollars):

• **Value Park Garage** (6145 Viscount Rd): **C$32 daily**, **C$160 for the first 7 days**. Covered except the rooftop, with the free Terminal Link train every 4 minutes (about 7–12 minutes to the terminals).
• **Value Park Lot** (6135 Viscount Rd): online only, price varies; Pearson calls it its most affordable parking. Terminal Link train to the terminals.
• **Daily Park, Terminal 1 and Terminal 3 garages**: **C$42 daily maximum**, **C$235 for the first 7 days**. A 3–5 minute walk.
• **Preferred Park** (T1, reserved): **C$46 daily maximum**, **C$255 for the first 7 days**.
• **Valet Care** (T1): **C$56 daily maximum** plus a one-time **C$20** valet fee, **C$275 for the first 7 days**.
• **Express Park** (T1, short stays): **C$59 daily maximum**, 2–3 minutes from the terminal.

Online bookings can be cancelled free more than 24 hours before they start; within 24 hours a fee applies.`,
    },
    {
      heading: "Free Waiting Areas",
      body: `Pearson's **free waiting areas** allow up to 45 minutes and you must stay with your vehicle. Free Waiting Area 1 is off Viscount Road via Network Road; Free Waiting Area 2 has EV fast chargers. Parking on the roadsides leading into the terminals can bring a C$85 payment notice.`,
    },
    {
      heading: "Getting There Without Parking",
      body: `**UP Express** runs from Terminal 1 to Union Station every 15 minutes, seven days a week, stopping at Weston, Mount Dennis and Bloor. An adult one-way fare is **C$12.35**, or **C$9.25 with PRESTO**. From Terminal 3, take the free Terminal Link train to Terminal 1.

**TTC 900 Airport Express** buses run to Kipling Station on Line 2. An adult TTC fare is **C$3.30** with PRESTO or a tap card (2-hour transfer), or C$3.35 cash.

Taxis and limos charge flat rates by zone with no surge pricing. **Uber, Lyft and Hopp** pick up at marked zones: at T1, zones 3–5 (doors P–S); at T3, zones 2–6 (doors B and D).`,
    },
  ],

  faqs: [
    {
      question: "How much is parking at Toronto Pearson?",
      answer:
        "Value Park Garage is C$32 a day (C$160 for the first 7 days), Daily Park at Terminals 1 and 3 is C$42 a day (C$235 for 7 days), Preferred Park is C$46, Valet Care is C$56 plus a C$20 fee, and Express Park is C$59 a day.",
    },
    {
      question: "What is the most affordable parking Pearson runs?",
      answer:
        "Pearson calls its Value Park Lot (6135 Viscount Rd) its most affordable option; it is sold online only, at a varying price. The Value Park Garage next door is C$32 a day or C$160 for the first 7 days at the gate, with the free Terminal Link train every 4 minutes.",
    },
    {
      question: "Is there a free cell phone lot at Toronto Pearson?",
      answer:
        "Yes. Pearson's free waiting areas allow up to 45 minutes; you must stay with your vehicle. Free Waiting Area 1 is off Viscount Road via Network Road.",
    },
    {
      question: "How do I get from Pearson to downtown Toronto?",
      answer:
        "UP Express runs from Terminal 1 to Union Station every 15 minutes for C$12.35 (C$9.25 with PRESTO). The TTC 900 bus to Kipling Station costs C$3.30 with PRESTO.",
    },
    {
      question: "Can I cancel a Pearson parking booking?",
      answer: "Yes, free online more than 24 hours before the booking starts. Within 24 hours a cancellation fee applies.",
    },
  ],
};

export default yyzNoLots;
