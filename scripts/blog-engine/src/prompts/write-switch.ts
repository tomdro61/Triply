/**
 * Prompt version switch for A/B experiment.
 *
 * Set PROMPT_VERSION=v2 in .env to use the new mobile-first / GEO-optimized prompts.
 * Default is v1 (the prompt set that generated all FLL/PHL/SEA articles through 2026-04-22).
 *
 * Articles generated with each version are stamped in their log file's `promptVersion` field
 * so GSC/Clarity/Bing data can later filter by version for A/B comparison.
 */
import * as v1 from './write.js'
import * as v2 from './write-v2.js'

const VERSION = (process.env.PROMPT_VERSION || 'v1').toLowerCase()

if (VERSION !== 'v1' && VERSION !== 'v2') {
  console.error(`Invalid PROMPT_VERSION: "${VERSION}". Must be 'v1' or 'v2'. Defaulting to v1.`)
}

const impl = VERSION === 'v2' ? v2 : v1

export const PROMPT_VERSION = VERSION === 'v2' ? 'v2' : 'v1'
export const buildWritePrompt = impl.buildWritePrompt
export const getWritingRulesBlock = impl.getWritingRulesBlock
export const getAirportDataBlock = impl.getAirportDataBlock
export const getExternalLinksBlock = impl.getExternalLinksBlock
