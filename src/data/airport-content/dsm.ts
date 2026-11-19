import { AirportContent } from "./types";

const dsmContent: AirportContent = {
  publishedOn: "2026-11-19",
  updatedOn: "2026-11-19",
  metaDescription:
    "Des Moines airport parking rates compared: DSM lots run $7–$48/day. Book an off-site DSM lot with a 24/7 on-demand shuttle ahead, with free cancellation.",

  sections: [
    {
      heading: "Des Moines Airport Parking Rates — What DSM Charges",
      body: `Des Moines International Airport is building a new terminal that it says opens in 2027. A new section of the parking garage opened on July 1, 2025, adding more than 1,100 covered spaces for a total of over 2,900.

Current rates at DSM (all $2 an hour, up to a daily maximum):
• **Garage – Hourly** — first two hours free, then up to $48 a day
• **Garage – Daily (Long Term)** — $21 a day
• **Blue Economy Lot** — $14 a day
• **Grey Economy Lot** — $8 a day
• **Red Economy Lot** — $7 a day

The economy lots have a free 24/7 shuttle, every 10 minutes or less from Grey and Blue and every 15 minutes from Red. Stays are limited to 60 days in a row.`,
    },
    {
      heading: "Off-Airport Parking Near DSM",
      body: `**Clarion Inn Des Moines Airport** — Hotel lot 1.3 miles from the terminal with a **24/7 on-demand shuttle**, so early departures and late returns are covered. The lot list on this page shows today's rate, and a search with your dates shows the total with taxes and fees before you pay.`,
    },
    {
      heading: "Pickups During Terminal Construction",
      body: `Building the new terminal has cut curb space at DSM, so waiting at the curb is no longer allowed. Instead:
• **EZ-PICKUP** — Two hours of free waiting in marked stalls in the Hourly Garage, then $2 an hour. It stays in place until the new terminal opens.
• **Cell Phone Waiting Lot** — Free, south of the airport, for up to 60 minutes at a time.
• **Rideshare and taxis** — Uber and Lyft pick up in the parking garage at the Ride App EZ-Pickup area. Taxis wait outside the baggage claim exit.`,
    },
    {
      heading: "Tips for Parking at Des Moines Airport",
      body: `• **Compare the economy lots** — Grey ($8) and Red ($7) cost less than Blue ($14) and are served by the same free 24/7 shuttle.
• **Arrive early** — DSM recommends 90 minutes to two hours before departure. The security checkpoint opens at 3:45 AM.
• **No airport coupons** — DSM's official parking says it doesn't offer or accept coupons.`,
    },
  ],

  faqs: [
    {
      question: "What are the parking rates at Des Moines airport?",
      answer:
        "DSM charges $2 an hour everywhere, with daily maximums of $48 in the Hourly Garage (first two hours free), $21 in the Daily Garage, $14 in the Blue Economy Lot, $8 in the Grey lot and $7 in the Red lot. For an off-site lot, the lot list on this page shows today's rate.",
    },
    {
      question: "What is the cheapest parking at DSM?",
      answer:
        "On the airport, the Red Economy Lot is the cheapest at $7 a day, with a free shuttle every 15 minutes. Off-site prices change with your dates; the lot list on this page shows current rates.",
    },
    {
      question: "Does the off-site DSM lot run a shuttle at night?",
      answer:
        "Yes. Clarion Inn Des Moines Airport, 1.3 miles from the terminal, lists a 24/7 on-demand shuttle.",
    },
    {
      question: "Can I wait at the curb at Des Moines airport?",
      answer:
        "No. Terminal construction has cut curb space, so DSM no longer allows curb waiting. Use EZ-PICKUP (two hours free in the Hourly Garage) or the free Cell Phone Waiting Lot south of the airport.",
    },
    {
      question: "When does the new Des Moines airport terminal open?",
      answer:
        "The airport says its new terminal opens in 2027, adding six gates when it opens. Until then, EZ-PICKUP replaces curb waiting.",
    },
    {
      question: "How early should I get to DSM?",
      answer:
        "DSM recommends arriving 90 minutes to two hours before departure. The security checkpoint opens at 3:45 AM.",
    },
    {
      question: "Can I cancel my DSM parking reservation?",
      answer:
        "Most DSM parking booked through Triply can be cancelled free up to 24 hours before your scheduled check-in. Check the cancellation policy on the lot's page for its exact terms.",
    },
  ],
};

export default dsmContent;
