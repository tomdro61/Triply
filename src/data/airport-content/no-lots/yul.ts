import type { NoLotsGuide } from ".";

// Sources (checked 2026-11-10; notes/empty-hubs-2026-11-10/YUL.md):
// admtl.com parking overview, HotelParc, ValetParc, P4, P9, P10, A1,
// accompanist and taxi pages; stm.info 747 page (live). CellParc's exact
// location, rideshare pick-up and REM airport opening are unconfirmed, so
// none are stated. ADM says only the C$1.05 fee inside the taxi fare is
// "taxes included", so the fare itself carries no tax claim.
const yulNoLots: NoLotsGuide = {
  publishedOn: "2026-11-10",
  updatedOn: "2026-11-10",
  metaDescription:
    "Montreal-Trudeau (YUL) parking guide: EconoParc and AeroParc C$35/day or C$245/week with free 24/7 shuttles, covered P4 C$45/day, valet, free waiting lots and the 747 bus.",

  sections: [
    {
      heading: "Montreal-Trudeau Airport Parking at a Glance",
      body: `Montréal-Trudeau International Airport runs its own parking, from economy lots with free shuttles to valet inside the terminal (Aéroports de Montréal gate rates, November 2026; prices in Canadian dollars):

• **EconoParc P9, EconoParc P10 and AeroParc A1**: **C$35 per 24 hours**, **C$245 per 7 days**. Free 24/7 shuttles to the terminal.
• **P4**: **C$45 per 24 hours**, **C$315 per 7 days**. Covered, a walk or a free 24/7 wheelchair-adapted shuttle, with EV charging.
• **ValetParc** (HotelParc level SS2): **C$60 per 24 hours**, **C$420 per 7 days**. Covered and heated; leave your keys at the terminal.
• **HotelParc short-term** (level SS1): C$8 per 20 minutes up to **C$75 per 24 hours**, directly connected to the terminal and meant for stays of three hours or less.

Except ValetParc, which charges its daily rate from the first minute, the lots bill C$8 per 20 minutes from the first minute up to the daily maximum, and a started extra day is charged in full. Online reservations can be changed or cancelled up to 2 hours before. HotelParc and ValetParc have a 2.05 m height limit and P4 a 2.3 m limit; studded tires are not allowed in any of the three.`,
    },
    {
      heading: "Free Waiting and Drop-Off",
      body: `**CellParc** gives up to two hours of free parking while you wait for a flight. The **P4 Express Drop-Off** is free with no time limit for pick-ups and drop-offs (not parking); its entrance is via Cardinal Avenue and Stuart-Graham Boulevard. At the **P10 Express Drop-Off**, take a ticket: the first 2 hours are free, then P10 rates apply.`,
    },
    {
      heading: "Getting There Without Parking",
      body: `**STM bus 747** runs 24/7 between the airport, Lionel-Groulx and Berri-UQAM metro stations and the Gare d'autocars de Montréal, every 10–15 minutes during the day. The fare is **C$11.25**, a 24-hour pass that also covers STM buses, the metro, the REM and trains in Zone A. Pay with exact change on board, at the STM counter and machines at door 28 (international arrivals) or in the Chrono app.

**Taxis** charge a fixed fare to downtown: **C$49.45 from 5 a.m. to 11 p.m.** and **C$56.70 from 11 p.m. to 5 a.m.** The taxi dispatcher is at door 23 on the arrivals level.`,
    },
  ],

  faqs: [
    {
      question: "How much is parking at Montreal-Trudeau airport?",
      answer:
        "The economy lots (EconoParc P9 and P10, AeroParc A1) are C$35 per 24 hours or C$245 per week, the covered P4 is C$45 per 24 hours, ValetParc is C$60 per 24 hours and HotelParc short-term is up to C$75 per 24 hours (gate rates, November 2026).",
    },
    {
      question: "What is the lowest gate rate at YUL's own parking?",
      answer:
        "C$35 per 24 hours or C$245 for 7 days, at EconoParc P9, EconoParc P10 and AeroParc A1, each with a free 24/7 shuttle to the terminal.",
    },
    {
      question: "Is there free parking at Montreal airport?",
      answer:
        "CellParc gives up to two hours free while you wait, the P4 Express Drop-Off is free for pick-ups and drop-offs, and the P10 Express Drop-Off is free for the first 2 hours.",
    },
    {
      question: "How do I get from YUL to downtown Montreal?",
      answer:
        "STM bus 747 runs 24/7 to Lionel-Groulx and Berri-UQAM for C$11.25 (a 24-hour pass), or a taxi costs a fixed C$49.45 by day and C$56.70 at night.",
    },
    {
      question: "Is there covered parking at YUL?",
      answer:
        "Yes. P4 is covered (C$45 per 24 hours), and HotelParc and ValetParc are underground and heated.",
    },
  ],
};

export default yulNoLots;
