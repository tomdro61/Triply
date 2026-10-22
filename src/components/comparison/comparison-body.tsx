import Link from "next/link";
import { ChevronRight, ArrowRight, Check, Info } from "lucide-react";
import { ComparisonView } from "@/lib/comparison/build";
import { liveComparisons } from "@/data/comparison";

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** "2026-08-19" → "August 19, 2026", without pulling in a date library. */
function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function ComparisonBody({ view }: { view: ComparisonView }) {
  const { airport } = view;
  const hubHref = `/${airport.slug}/airport-parking`;
  const apr = view.competitors.find((c) => c.key === "apr");
  const spothero = view.competitors.find((c) => c.key === "spothero");
  const others = liveComparisons.filter((c) => c.slug !== airport.slug);
  const wins = view.sameLot.filter((r) => r.triplyWins);

  return (
    <>
      {/* Breadcrumb — the BreadcrumbList JSON-LD is emitted by
          buildComparisonSchemas, so this renders links only. Every crumb is a
          real internal link back into the airport hub cluster. */}
      <nav
        aria-label="Breadcrumb"
        className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-2"
      >
        <ol className="flex items-center text-sm text-gray-500 flex-wrap">
          <li>
            <Link href="/" className="hover:text-brand-orange transition-colors">
              Home
            </Link>
          </li>
          <li className="flex items-center">
            <ChevronRight className="w-4 h-4 mx-2 text-gray-400" />
            <Link
              href="/airport-parking"
              className="hover:text-brand-orange transition-colors"
            >
              Airport Parking
            </Link>
          </li>
          <li className="flex items-center">
            <ChevronRight className="w-4 h-4 mx-2 text-gray-400" />
            <Link href={hubHref} className="hover:text-brand-orange transition-colors">
              {airport.city} ({airport.code})
            </Link>
          </li>
          <li className="flex items-center">
            <ChevronRight className="w-4 h-4 mx-2 text-gray-400" />
            <span className="text-gray-700 font-medium">
              SpotHero vs APR vs Triply
            </span>
          </li>
        </ol>
      </nav>

      {/* Answer-first lede. Deliberately the first prose on the page: this is
          the block an LLM lifts, so it has to carry the whole answer. */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-8">
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4 max-w-4xl">
          SpotHero vs AirportParkingReservations vs Triply —{" "}
          {airport.city} ({airport.code}) parking compared
        </h1>
        <p className="text-lg text-gray-700 leading-relaxed max-w-4xl">
          {view.lede}
        </p>
        <p className="mt-3 text-sm text-gray-500">
          Last updated {longDate(view.lastUpdated)}. Triply rates are live for a
          sample {view.triplyDays ?? 7}-day trip and change daily.
          {apr?.verifiedOn || spothero?.verifiedOn ? (
            <>
              {" "}
              Competitor rates were last checked on their own airport pages
              {apr ? ` (${apr.shortName} ${longDate(apr.verifiedOn)}` : ""}
              {apr && spothero ? `, ${spothero.shortName} ${longDate(spothero.verifiedOn)})` : apr ? ")" : ""}
              .
            </>
          ) : null}
        </p>
      </section>

      {/* TL;DR — short, factual, extractable. */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-10">
        <div className="rounded-xl border border-gray-200 bg-orange-50/40 p-6 max-w-4xl">
          <h2 className="text-base font-semibold text-gray-900 mb-4">
            The short version
          </h2>
          <ul className="space-y-2.5 text-sm text-gray-700">
            {view.pricesAsserted && view.triplyFrom !== null && (
              <li className="flex gap-2">
                <Check className="w-4 h-4 text-brand-orange shrink-0 mt-0.5" />
                <span>
                  <strong>Triply Pro</strong> lists {view.triplyLotCount}{" "}
                  {airport.code} lots from{" "}
                  <strong>{money(view.triplyFrom)}/day</strong>
                  {view.triplyCheapestLotName
                    ? ` (${view.triplyCheapestLotName})`
                    : ""}
                  .
                </span>
              </li>
            )}
            {view.triplyAllInDaily !== null && view.triplyAllInTotal !== null && (
              <li className="flex gap-2">
                <Check className="w-4 h-4 text-brand-orange shrink-0 mt-0.5" />
                <span>
                  <strong>All-in, after the Triply service fee:</strong>{" "}
                  {money(view.triplyAllInTotal)} for {view.triplyDays} days —
                  about {money(view.triplyAllInDaily)}/day. Nothing is added
                  after checkout.
                </span>
              </li>
            )}
            {view.competitors
              .filter((c) => c.fromRate !== null)
              .map((c) => (
                <li key={c.key} className="flex gap-2">
                  <Check className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" />
                  <span>
                    <strong>{c.name}</strong> advertises from{" "}
                    {money(c.fromRate as number)}/day
                    {c.fromRateLot ? ` (${c.fromRateLot})` : ""}
                    {c.fromRateHasShuttle ? "" : " — no free shuttle on that lot"}
                    .
                  </span>
                </li>
              ))}
            {view.onAirport.map((r) => (
              <li key={r.label} className="flex gap-2">
                <Check className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" />
                <span>
                  On-airport benchmark: {r.label}{" "}
                  <strong>${r.dailyRate}/day</strong>.
                </span>
              </li>
            ))}
          </ul>
          <Link
            href={hubHref}
            className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-brand-orange hover:underline"
          >
            See all {view.triplyLotCount} {airport.code} lots and live rates
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </section>

      {/* Head-to-head */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          Head-to-head at {airport.code}
        </h2>
        <p className="text-sm text-gray-500 mb-6">
          Triply figures are live. Competitor figures are the rates each
          platform advertises on its own {airport.code} page, before that
          platform&apos;s taxes and fees.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[560px]">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-3 pr-4 text-sm font-semibold text-gray-600" />
                <th className="py-3 px-4 text-sm font-semibold text-brand-orange">
                  Triply Pro
                </th>
                {view.competitors.map((c) => (
                  <th
                    key={c.key}
                    className="py-3 px-4 text-sm font-semibold text-gray-600"
                  >
                    {c.shortName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="py-3.5 pr-4 text-sm text-gray-600">
                  Advertised from
                </td>
                <td className="py-3.5 px-4 text-sm font-bold text-brand-orange">
                  {view.triplyFrom !== null ? `${money(view.triplyFrom)}/day` : "See live rates"}
                </td>
                {view.competitors.map((c) => (
                  <td key={c.key} className="py-3.5 px-4 text-sm text-gray-900">
                    {c.fromRate !== null ? `${money(c.fromRate)}/day` : "Check current rate"}
                  </td>
                ))}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-3.5 pr-4 text-sm text-gray-600">
                  All-in price shown before checkout
                </td>
                <td className="py-3.5 px-4 text-sm font-medium text-gray-900">
                  {view.triplyAllInDaily !== null
                    ? `Yes — ${money(view.triplyAllInDaily)}/day incl. fee`
                    : "Yes"}
                </td>
                {view.competitors.map((c) => (
                  <td key={c.key} className="py-3.5 px-4 text-sm text-gray-500">
                    Rate shown before taxes &amp; fees
                  </td>
                ))}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-3.5 pr-4 text-sm text-gray-600">
                  Off-airport lots listed
                </td>
                <td className="py-3.5 px-4 text-sm text-gray-900">
                  {view.triplyLotCount}
                </td>
                {view.competitors.map((c) => (
                  <td key={c.key} className="py-3.5 px-4 text-sm text-gray-900">
                    {c.lotCount ?? "—"}
                  </td>
                ))}
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-3.5 pr-4 text-sm text-gray-600 align-top">
                  Best for
                </td>
                <td className="py-3.5 px-4 text-sm text-gray-900 align-top">
                  {view.bestFor.triply}
                </td>
                {view.competitors.map((c) => (
                  <td
                    key={c.key}
                    className="py-3.5 px-4 text-sm text-gray-900 align-top"
                  >
                    {view.bestFor[c.key]}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="py-3.5 pr-4 text-sm text-gray-600 align-top">
                  Trade-off
                </td>
                <td className="py-3.5 px-4 text-sm text-gray-500 align-top">
                  Newer platform — fewer reviews than the incumbents
                </td>
                {view.competitors.map((c) => (
                  <td
                    key={c.key}
                    className="py-3.5 px-4 text-sm text-gray-500 align-top"
                  >
                    {c.weaknesses[0] ?? "—"}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Same lot, two prices — the single most persuasive block on the page,
          and the only one that is a genuine apples-to-apples comparison. Rows
          are matched against live Triply lot names, so a lot we stop carrying
          drops out on its own. */}
      {view.sameLot.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            Same lot, two prices
          </h2>
          <p className="text-sm text-gray-500 mb-6">
            Lots that both platforms carry at {airport.code}. Same lot, same
            shuttle — different retail price.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left min-w-[520px]">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="py-3 pr-4 text-sm font-semibold text-gray-600">
                    Lot
                  </th>
                  <th className="py-3 px-4 text-sm font-semibold text-gray-600">
                    Platform
                  </th>
                  <th className="py-3 px-4 text-sm font-semibold text-brand-orange text-right">
                    Triply
                  </th>
                  <th className="py-3 pl-4 text-sm font-semibold text-gray-600 text-right">
                    Their price
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.sameLot.map((row, idx) => (
                  <tr
                    key={`${row.lot}-${row.competitor}-${idx}`}
                    className="border-b border-gray-100"
                  >
                    <td className="py-3.5 pr-4 text-sm font-medium text-gray-900">
                      {row.lot}
                    </td>
                    <td className="py-3.5 px-4 text-sm text-gray-500">
                      {view.competitors.find((c) => c.key === row.competitor)
                        ?.shortName ?? row.competitor}
                    </td>
                    <td
                      className={`py-3.5 px-4 text-sm text-right font-bold ${
                        row.triplyWins ? "text-brand-orange" : "text-gray-900"
                      }`}
                    >
                      {money(row.triplyRate)}
                    </td>
                    <td className="py-3.5 pl-4 text-sm text-right text-gray-900">
                      {money(row.competitorRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Matchups, not lots — one physical lot can appear twice when both
              competitors carry it, and counting those as two wins would
              overstate the scoreline on the one table people check. */}
          {wins.length > 0 && (
            <p className="mt-4 text-sm text-gray-600 max-w-3xl">
              Triply is cheaper on {wins.length} of {view.sameLot.length}{" "}
              matchups at {airport.code}.
            </p>
          )}
        </section>
      )}

      {/* Platform breakdown */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
        <h2 className="text-2xl font-bold text-gray-900 mb-6">
          What each platform is actually good at
        </h2>
        <div className="grid gap-5 md:grid-cols-3 max-w-5xl">
          <div className="rounded-xl border border-brand-orange/30 bg-orange-50/40 p-5">
            <h3 className="font-semibold text-gray-900 mb-2">Triply Pro</h3>
            <p className="text-sm text-gray-700 mb-3">{view.bestFor.triply}</p>
            <Link
              href={hubHref}
              className="text-sm font-medium text-brand-orange hover:underline inline-flex items-center gap-1"
            >
              See {airport.code} lots <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          {view.competitors.map((c) => (
            <div
              key={c.key}
              className="rounded-xl border border-gray-200 bg-white p-5"
            >
              <h3 className="font-semibold text-gray-900 mb-2">{c.name}</h3>
              <p className="text-sm text-gray-700 mb-3">{view.bestFor[c.key]}</p>
              <ul className="space-y-1.5 text-sm text-gray-600">
                {c.strengths.map((s) => (
                  <li key={s} className="flex gap-2">
                    <Check className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-1" />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* Methodology — the honesty block. Comparison pages that concede the
          method get cited; ones that read as an ad get skipped. */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-6 max-w-4xl">
          <div className="flex gap-3">
            <Info className="w-5 h-5 text-gray-400 shrink-0 mt-0.5" />
            <div className="text-sm text-gray-600 leading-relaxed">
              <p className="font-semibold text-gray-900 mb-2">
                How we compared
              </p>
              <p className="mb-2">
                Triply rates are pulled live from our inventory for a sample{" "}
                {view.triplyDays ?? 7}-day trip starting tomorrow, and refresh
                hourly. SpotHero and AirportParkingReservations rates are the
                &ldquo;from&rdquo; prices each platform advertises on its own{" "}
                {airport.code} page, read by hand on the dates stamped above —
                we do not scrape them.
              </p>
              <p>
                Every platform adds fees at checkout. Triply&apos;s is a single
                service fee with a flat minimum, which is why the all-in row
                above matters more than the headline rate on a short trip.
                Prices move daily and by travel dates; book the date you need to
                see your real total.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Cross-links to the sibling comparison pages + the hub cluster. */}
      {others.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            Compare parking at other airports
          </h2>
          <div className="flex flex-wrap gap-3">
            {others.map((c) => (
              <Link
                key={c.slug}
                href={`/${c.slug}/spothero-vs-airportparkingreservations-vs-triply`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 hover:border-brand-orange hover:text-brand-orange transition-colors"
              >
                SpotHero vs APR vs Triply — {c.code}
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            ))}
            <Link
              href="/airport-parking"
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 hover:border-brand-orange hover:text-brand-orange transition-colors"
            >
              All airports
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </section>
      )}
    </>
  );
}
