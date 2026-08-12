export function scrollDashboardGridIntoView() {
  const grid = document.querySelector('.dashboard-grid')
  if (!(grid instanceof HTMLElement)) return
  const offset = 88
  const top = window.scrollY + grid.getBoundingClientRect().top - offset
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}

export function scheduleScrollDashboardGridIntoView(delayMs = 0) {
  // Delay lets filtered lists expand so scroll has enough page height.
  window.setTimeout(scrollDashboardGridIntoView, delayMs)
}

/** After filter pills, wait for layout/height to settle. */
export const FILTER_SCROLL_DELAY_MS = 500
