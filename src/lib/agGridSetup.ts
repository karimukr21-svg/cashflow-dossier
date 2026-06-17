// AG Grid v35 — register the community modules once, app-wide.
// v34+ requires explicit module registration; without it the grid throws at runtime.
// Theming uses the Theming API (themeQuartz) — no legacy CSS import needed.
import { ModuleRegistry, AllCommunityModule, themeQuartz } from 'ag-grid-community'

ModuleRegistry.registerModules([AllCommunityModule])

// CCC-tinted Quartz theme (crimson accent, compact rows) shared by manage-mode grids.
export const cccGridTheme = themeQuartz.withParams({
  accentColor: '#e10020',
  headerBackgroundColor: '#f8fafc',
  headerTextColor: '#475569',
  fontSize: 12.5,
  headerFontSize: 11,
  rowHeight: 30,
  headerHeight: 34,
  borderColor: '#eef2f7',
})
