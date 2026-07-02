import { createContext, useContext } from 'react'
import { fmt } from './format'

/* Display currency + denomination controls for the per-area cash-flow page
 * (AreaDrill). Cash values are stored in FULL NATIVE units, so the area page
 * shows them natively by default (Local · Units — its long-standing view).
 * USD mode multiplies by the area's FX rate; the denomination is a display
 * divisor. Threaded through the card tree + EditableCell via context so every
 * figure follows the selected mode without prop-drilling. */

export type Denom = 'm' | 'k' | 'u'
export const DENOM: Record<Denom, { div: number; dec: number; word: string; btn: string }> = {
  m: { div: 1e6, dec: 1, word: 'millions', btn: 'Millions' },
  k: { div: 1e3, dec: 1, word: "'000",     btn: "'000" },
  u: { div: 1,   dec: 0, word: 'units',    btn: 'Units' },
}
export const unitLabel = (cur: string, d: Denom) => d === 'u' ? cur : `${cur} ${DENOM[d].word}`

export type DispFmt = (v: number | null | undefined) => string
/** Build a display formatter: native value → (×rate for USD) → /divisor, shown
 *  to the denomination's decimals. null renders as blank. */
export const makeDisp = (rate: number, d: Denom): DispFmt =>
  (v) => v == null ? '' : fmt((v * rate) / DENOM[d].div, { decimals: DENOM[d].dec })

// Fallback = the area page's prior behaviour (native, full units, blank on null).
const defaultDisp: DispFmt = (v) => v == null ? '' : fmt(v)
export const DispFmtCtx = createContext<DispFmt>(defaultDisp)
export const useDisp = () => useContext(DispFmtCtx)
