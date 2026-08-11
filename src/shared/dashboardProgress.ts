import type { DashboardProgress } from './types.js'

/** Overall load ranges so no mid-flight phase can paint the bar at 100%. */
const PHASE_RANGE: Record<
  DashboardProgress['phase'],
  { start: number; end: number }
> = {
  starting: { start: 0, end: 5 },
  jira: { start: 5, end: 15 },
  'github-search': { start: 15, end: 40 },
  'github-details': { start: 40, end: 90 },
  mapping: { start: 90, end: 100 },
}

export function dashboardProgressPercent(
  progress?: DashboardProgress | null,
): number {
  if (!progress) return 0
  const range = PHASE_RANGE[progress.phase]
  const span = range.end - range.start
  if (
    progress.total != null &&
    progress.total > 0 &&
    progress.current != null
  ) {
    const fraction = Math.min(1, Math.max(0, progress.current / progress.total))
    return Math.round(range.start + fraction * span)
  }
  return range.start
}
