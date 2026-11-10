import { AirportContent } from "../types";

// Sources (checked 2026-11-10; notes/empty-hubs-2026-11-10/DAL.md):
// dallas-lovefield.com garages/valet, cell phone lot, public transport and
// directions pages (Wayback captures 16–30 Oct 2026: the live site did not
// resolve on 10 Nov), dart.org Love Field + Route 5 + fares pages (live).
// Hourly rates are in a PDF we did not open, so none are quoted.
const dalNoLots: AirportContent = {
  publishedOn: "2026-11-10",
  updatedOn: "2026-11-10",
  metaDescription:
    "Dallas Love Field (DAL) parking guide: official garage rates from $18/day, valet $35, the free cell phone lot, DART Route 5 to the airport, and how DAL compares with DFW.",

  sections: [
    {
      heading: "Dallas Love Field Parking at a Glance",
      body: `Dallas Love Field sits at Mockingbird Lane and Herb Kelleher Way, about seven miles from downtown Dallas, and is Southwest Airlines' home base. All of its parking is on the airport: three garages next to the terminal plus valet. There is no shuttle lot, so every space is a short walk away.

Official daily rates (Dallas Love Field, October 2026):
• **Garage B roof**: $18/day, uncovered, about an 8-minute walk
• **Garage C roof**: $20/day, uncovered, about a 4-minute walk
• **Garage B and Garage C covered levels**: $21/day
• **Garage A**: $24/day, all levels covered, about a 5-minute walk to the ticketing hall
• **Garage C 3rd-level Premium**: $30/day
• **Contactless Valet**: $35/day, connected to the south end of the ticketing hall

Self-park spaces are first-come, first-served and valet needs no reservation. No weekly rate is published. You can pay with an NTTA TollTag, cash or card, and the maximum stay is 60 days.`,
    },
    {
      heading: "Free Parking and Pickups",
      body: `Garages A and B are free for the first 30 minutes. Garage C is free for the first 59 minutes on levels 1–2 and 4–7.

The **cell phone waiting lot** at the northeast corner of Hawes and Herb Kelleher is free for up to 60 minutes. Uber, Lyft, taxis and car services pick up at the valet pavilion and Garage C Level 1, and drop off at the upper-level ticketing hall.`,
    },
    {
      heading: "Getting to Love Field Without Parking",
      body: `**DART Route 5 Love Link** runs between the terminal and Inwood/Love Field Station on DART's Green and Orange rail lines, every 15 minutes at weekday peak and midday and every 30 minutes off-peak. It stops on the lower-level drive outside baggage claim. DART's Local 3-Hour Pass is $3.00 and a Local Day Pass is $6.00.

From Inwood/Love Field Station, the Green and Orange lines run into downtown Dallas, and the Orange Line continues to DFW Airport Terminal A.`,
    },
    {
      heading: "Love Field or DFW?",
      body: `DFW is about 18 miles from Love Field, roughly a 30-minute drive with no traffic (longer at rush hour). Love Field is the closer airport to downtown and has every space within walking distance of the terminal. DFW has far more airlines and also has off-airport parking you can compare: see Dallas (DFW) in the airports below.`,
    },
  ],

  faqs: [
    {
      question: "How much is parking at Dallas Love Field?",
      answer:
        "Official daily rates run from $18 (Garage B roof) to $30 (Garage C 3rd-level Premium) for self-parking, and $35 for valet. Garage A is $24 a day and the covered levels of Garages B and C are $21 (Dallas Love Field, October 2026).",
    },
    {
      question: "What is the cheapest parking at Love Field?",
      answer: "The uncovered roof of Garage B at $18 a day, about an 8-minute walk to the terminal.",
    },
    {
      question: "Is there free parking at Dallas Love Field?",
      answer:
        "Garages A and B are free for the first 30 minutes, and Garage C levels 1–2 and 4–7 are free for the first 59 minutes. The cell phone lot at Hawes and Herb Kelleher is free for up to 60 minutes.",
    },
    {
      question: "Do I need a shuttle from Love Field parking?",
      answer: "No. Garages A, B and C sit next to the terminal, a 4–8 minute walk, with skybridges into the terminal.",
    },
    {
      question: "Can I take DART to Love Field?",
      answer:
        "Yes. DART Route 5 Love Link runs between the terminal and Inwood/Love Field Station on the Green and Orange lines, every 15 minutes at weekday peak and midday.",
    },
    {
      question: "Where do Uber and Lyft pick up at Love Field?",
      answer: "At the valet pavilion and Garage C Level 1. Drop-off is at the upper-level ticketing hall.",
    },
  ],
};

export default dalNoLots;
