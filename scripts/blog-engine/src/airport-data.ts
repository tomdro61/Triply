import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '..', 'data', 'airports')

export interface AirportData {
  code: string
  fullName: string
  lastVerified: string
  terminals: { name: string; airlines: string[] }[]
  roads: string[]
  transit: string[]
  neighborhoods: string[]
  authority: string
  parkingRates: string
  shuttleInfo: string
  distanceFromCity: string
}

export function loadAirportData(code: string): AirportData | null {
  const filepath = path.join(DATA_DIR, `${code.toUpperCase()}.json`)
  if (!fs.existsSync(filepath)) {
    return null
  }

  const data: AirportData = JSON.parse(fs.readFileSync(filepath, 'utf-8'))

  // Warn if data is stale (>90 days old)
  const lastVerified = new Date(data.lastVerified)
  const daysSinceVerified = Math.floor((Date.now() - lastVerified.getTime()) / (1000 * 60 * 60 * 24))
  if (daysSinceVerified > 90) {
    console.warn(
      `  \u26a0\ufe0f ${code}.json last verified ${data.lastVerified} (${daysSinceVerified} days ago) \u2014 consider updating rates before generating.`
    )
  }

  return data
}

export function getEntityPatterns(data: AirportData): RegExp[] {
  const patterns: RegExp[] = []

  // Terminal patterns
  for (const t of data.terminals) {
    const escaped = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    patterns.push(new RegExp(escaped, 'i'))
  }

  // Airline patterns (combine all into one alternation)
  const allAirlines = data.terminals.flatMap((t) => t.airlines)
  if (allAirlines.length > 0) {
    const escaped = allAirlines.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    patterns.push(new RegExp(`(${escaped.join('|')})`, 'i'))
  }

  // Roads
  if (data.roads.length > 0) {
    const escaped = data.roads.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    patterns.push(new RegExp(`(${escaped.join('|')})`, 'i'))
  }

  // Transit
  if (data.transit.length > 0) {
    const escaped = data.transit.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    patterns.push(new RegExp(`(${escaped.join('|')})`, 'i'))
  }

  // Neighborhoods
  if (data.neighborhoods.length > 0) {
    const escaped = data.neighborhoods.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    patterns.push(new RegExp(`(${escaped.join('|')})`, 'i'))
  }

  // Authority
  if (data.authority) {
    patterns.push(new RegExp(data.authority.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  }

  return patterns
}
