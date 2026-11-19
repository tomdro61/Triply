import { AirportContent } from "./types";

const contentModules: Record<string, () => Promise<{ default: AirportContent }>> = {
  ATL: () => import("./atl"),
  AUS: () => import("./aus"),
  BNA: () => import("./bna"),
  BOS: () => import("./bos"),
  BWI: () => import("./bwi"),
  CHS: () => import("./chs"),
  CLT: () => import("./clt"),
  CVG: () => import("./cvg"),
  DCA: () => import("./dca"),
  DEN: () => import("./den"),
  DFW: () => import("./dfw"),
  DSM: () => import("./dsm"),
  DTW: () => import("./dtw"),
  EWR: () => import("./ewr"),
  FLL: () => import("./fll"),
  IAD: () => import("./iad"),
  IAH: () => import("./iah"),
  JFK: () => import("./jfk"),
  LAS: () => import("./las"),
  LAX: () => import("./lax"),
  LGA: () => import("./lga"),
  MCO: () => import("./mco"),
  MIA: () => import("./mia"),
  MSP: () => import("./msp"),
  OAK: () => import("./oak"),
  ORD: () => import("./ord"),
  ORF: () => import("./orf"),
  PDX: () => import("./pdx"),
  PHL: () => import("./phl"),
  PHX: () => import("./phx"),
  RIC: () => import("./ric"),
  RNO: () => import("./rno"),
  SAN: () => import("./san"),
  SEA: () => import("./sea"),
  SFO: () => import("./sfo"),
  SJC: () => import("./sjc"),
  SLC: () => import("./slc"),
  SYR: () => import("./syr"),
  TPA: () => import("./tpa"),
};

/**
 * Load custom airport content if it exists.
 * Returns null for airports without custom content (template fallback).
 */
export async function getAirportContent(
  airportCode: string
): Promise<AirportContent | null> {
  const loader = contentModules[airportCode.toUpperCase()];
  if (!loader) return null;

  const mod = await loader();
  return mod.default;
}
