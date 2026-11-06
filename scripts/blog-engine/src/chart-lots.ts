/**
 * chart-lots.ts — how a lot from a live triplypro.com search is described on a rate chart (chart redraw, Nov 2026).
 *
 * Inputs are the lot's own shuttle text on our site (`shuttleInfo.summary` / `.details` from /api/search) and, when the
 * lot is in the airport's data file, that entry's `shuttleInfo` / `notes` / `cruiseShuttle`. Used by
 * reports/chart-redraw/prices.mts; kept here so the rules have tests.
 */
import { transferBlocker } from './prompts/write.js'
import { isNotAirportLot, VALET } from './airport-data.js'
import type { Transfer } from './rate-chart.js'

export interface LiveShuttle { name: string; summary?: string; details?: string }
type FileLot = Record<string, unknown> | undefined

// "Added fee of CAD $5 per adult" (a YYZ hotel shuttle) and "Shuttle payment will be collected" (a TPA hotel): costs the
// engine's transferBlocker doesn't list.
const PER_RIDER_FEE = /(?:C\$|CAD\s?\$?|US\$|\$)\s?\d+(?:\.\d{2})?\s*(?:per|\/|a|each)\s*(?:adult|passenger|guest|person|rider|travell?er)/i
const SHUTTLE_PAYMENT = /shuttle (?:payment|fee)s? (?:will be|is|are) (?:collected|charged)|pay(?:ment)? for the shuttle/i
const EXTRA_RIDER = /(?:additional|extra|beyond|more than \d)[^.]{0,30}$/i
const NO_SHUTTLE = /\bno (?:airport )?shuttle\b|shuttle (?:service )?(?:is )?not (?:available|provided|offered|included)|does not (?:offer|provide) (?:a |an )?(?:airport )?shuttle/i
const SHUTTLE = /shuttle|on[- ]demand|every\s+(?:\d|hour|half)|once an hour|hourly|continuous|to and from the airport|pick ?ups?\b|on the hour|top of the hour/i

/**
 * A transfer cost on top of the lot price: the blog engine's transferBlocker ("$10 each way", "C$8 fee", "shuttle is
 * NOT free", a paid cruise shuttle) or a per-rider / collected shuttle fee. The same test keeps a lot from leading.
 */
export function paidTransfer(live: LiveShuttle, file: FileLot): boolean {
  const text = [live.summary, live.details, file?.shuttleInfo].filter((t) => typeof t === 'string').join(' ')
  if (transferBlocker({ shuttleInfo: text, notes: file?.notes, cruiseShuttle: file?.cruiseShuttle })) return true
  if (SHUTTLE_PAYMENT.test(text)) return true
  const fee = text.match(PER_RIDER_FEE)
  return !!fee && !EXTRA_RIDER.test(text.slice(Math.max(0, (fee.index ?? 0) - 40), fee.index ?? 0))
}

/**
 * The "To terminal" label, from the lot's own words: its summary on our site first, the data file's shuttle text when
 * the summary is empty or says nothing about a shuttle. Conservative:
 *   - "No shuttle" only when the lot says so outright (a shuttle that stops overnight is still a shuttle);
 *   - "Valet" when it offers a driver/valet to the terminal and no shuttle;
 *   - "Shuttle" only on shuttle words; otherwise "—" (a hotel Lyft, an AirTrain).
 * A lot with no shuttle is labelled "No shuttle" even when the engine counts a rideshare as a paid transfer.
 */
export function transferOf(live: LiveShuttle, file: FileLot, paid: boolean): Transfer {
  const summary = (live.summary ?? '').trim()
  const fileText = typeof file?.shuttleInfo === 'string' ? file.shuttleInfo : ''
  const s = summary || fileText
  if (file?.shuttleSuspended === true || /shuttle (?:is )?suspended/i.test(s)) return 'none'
  if (/^\s*no shuttle/i.test(s) || (NO_SHUTTLE.test(s) && !/shuttle runs|every\s+\d|on demand/i.test(s))) {
    return VALET.test(`${s} ${fileText}`) ? 'valet' : 'none'
  }
  // "24/7 on demand" with a data file that says a driver meets you at the terminal (Simply Park, YYZ) is a valet.
  if (!/shuttle/i.test(summary) && (VALET.test(summary) || (/^\s*no shuttle/i.test(fileText) && VALET.test(fileText)))) return 'valet'
  if (paid) return 'paid'
  // A port lot whose data file confirms an included port shuttle (POE "7 AM to 2 PM" names no shuttle itself).
  if (SHUTTLE.test(s) || file?.cruiseShuttle === 'included') return 'shuttle'
  return 'unknown'
}

/**
 * A cruise-port lot, which an AIRPORT chart must not show: its name says cruise or ports, its own text sends the
 * shuttle to a port or cruise terminal (and not to the airport), or a data-file note matched to this exact lot says it
 * is a cruise-port lot. `fileMatchIsExact` = the data-file entry was matched by ResLab id or by a slug no other live lot
 * shares (two "Clarion Hotel BWI North" listings share one entry — only one of them runs to the port).
 */
export function cruisePortLot(live: LiveShuttle, file: FileLot, fileMatchIsExact: boolean): string {
  const own = `${live.summary ?? ''} ${live.details ?? ''}`
  // Its own text sends people to the airport ("Free 24/7 shuttle to FLL terminals", "pickups at Terminals 1–4").
  // A "cruise terminal" is the port's, never the airport's.
  const servesAirport = /\bairport\b[^.]{0,60}\bshuttle|shuttle[^.]{0,60}\b(?:airport\b|(?<!cruise )terminals?\b)|(?<!cruise )terminals? \d|pick ?ups? (?:at|from) (?:the )?(?:airport|(?<!cruise )terminal)/i.test(own)
  // "Park By The Ports AIRPORT Parking" (FLL, ResLab 244) is the operator's airport listing, not its cruise one.
  if (/\bcruise\b|\bby the ports?\b/i.test(live.name) && !/\bairport\b/i.test(live.name) && !servesAirport) return 'cruise-port lot (name)'
  if (/(?:to|from) (?:and from )?the (?:cruise )?port\b|port of [a-z]+|cruise (?:terminal|port|ship)/i.test(own) && !servesAirport) return 'shuttle runs to the cruise port'
  const notes = typeof file?.notes === 'string' ? file.notes : ''
  if (fileMatchIsExact && /cruise[- ]port lot|do not present it as general [a-z ]*airport parking|operator describes it for [^.]*cruise/i.test(notes)) return 'cruise-port lot (data file notes)'
  // lot-sync's note says "cruise-port/downtown lot", which the pattern above does not match (round-2 review of #160).
  if (fileMatchIsExact && file && isNotAirportLot(file)) return 'flagged by lot-sync as cruise-port/downtown (data file notes)'
  return ''
}
