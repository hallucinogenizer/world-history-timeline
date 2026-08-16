import type { TimelineEvent, ViewState } from "./types";

// Zoom limits (pixels per year).
export const MIN_PX_PER_YEAR = 0.02; // ~50 years per pixel — millennia in view
export const MAX_PX_PER_YEAR = 60; // finest granularity is a single year

// When the visible span exceeds this many years, only starred events are shown.
export const STAR_ONLY_SPAN_YEARS = 200;

export function clampScale(pxPerYear: number): number {
  return Math.min(MAX_PX_PER_YEAR, Math.max(MIN_PX_PER_YEAR, pxPerYear));
}

export function xOfYear(year: number, view: ViewState): number {
  return (year - view.leftYear) * view.pxPerYear;
}

export function yearOfX(x: number, view: ViewState): number {
  return view.leftYear + x / view.pxPerYear;
}

/** Visible span in years for a surface of the given pixel width. */
export function visibleSpanYears(width: number, view: ViewState): number {
  return width / view.pxPerYear;
}

export function isStarOnly(width: number, view: ViewState): boolean {
  return visibleSpanYears(width, view) > STAR_ONLY_SPAN_YEARS;
}

/**
 * Zoom by `factor` around a fixed screen x position, keeping the year under
 * that point stationary. Returns the new view.
 */
export function zoomAround(view: ViewState, screenX: number, factor: number): ViewState {
  const pxPerYear = clampScale(view.pxPerYear * factor);
  const yearAtPoint = yearOfX(screenX, view);
  const leftYear = yearAtPoint - screenX / pxPerYear;
  return { leftYear, pxPerYear };
}

/** Pan the view horizontally by a pixel delta (positive = content moves right). */
export function panBy(view: ViewState, dxPixels: number): ViewState {
  return { ...view, leftYear: view.leftYear - dxPixels / view.pxPerYear };
}

const NICE_STEPS = [
  1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000,
  20000, 50000,
];

/** Choose a "nice" year interval so ticks land roughly every `targetPx` pixels. */
export function niceStep(view: ViewState, targetPx = 96): number {
  const rough = targetPx / view.pxPerYear;
  for (const step of NICE_STEPS) {
    if (step >= rough) return step;
  }
  return NICE_STEPS[NICE_STEPS.length - 1];
}

export interface Tick {
  year: number;
  x: number;
}

/** Year gridline ticks covering the visible width (plus a small margin). */
export function computeTicks(width: number, view: ViewState): Tick[] {
  const step = niceStep(view);
  const startYear = Math.floor(yearOfX(-40, view) / step) * step;
  const endYear = yearOfX(width + 40, view);
  const ticks: Tick[] = [];
  for (let y = startYear; y <= endYear; y += step) {
    ticks.push({ year: y, x: xOfYear(y, view) });
    if (ticks.length > 400) break; // safety valve
  }
  return ticks;
}

export interface PlacedEvent {
  event: TimelineEvent;
  x: number;
  lane: number;
}

/**
 * Assign events to stacked lanes so their cards don't overlap horizontally.
 * Events are sorted left-to-right; each is placed in the lowest lane whose
 * last card ends before this card would start.
 */
export function layoutEvents(
  events: TimelineEvent[],
  view: ViewState,
  width: number,
  cardWidth: number,
): PlacedEvent[] {
  const margin = cardWidth + 40;
  const visible = events
    .map((event) => ({ event, x: xOfYear(event.year, view) }))
    .filter((p) => p.x > -margin && p.x < width + margin)
    .sort((a, b) => a.x - b.x);

  const laneEnds: number[] = []; // right edge (x) occupied per lane
  const gap = 8;
  const placed: PlacedEvent[] = [];
  for (const p of visible) {
    const left = p.x - cardWidth / 2;
    let lane = laneEnds.findIndex((end) => left > end + gap);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = p.x + cardWidth / 2;
    placed.push({ event: p.event, x: p.x, lane });
  }
  return placed;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** e.g. -500 => "500 BC", 1969 => "1969 AD", 0 => "1 BC". */
export function formatYear(year: number): string {
  if (year < 0) return `${-year} BC`;
  if (year === 0) return "1 BC";
  return `${year} AD`;
}

/** Compact label for axis ticks (no AD suffix to save space). */
export function formatYearShort(year: number): string {
  if (year < 0) return `${-year} BC`;
  if (year === 0) return "0";
  return `${year}`;
}

/** Full human date honoring optional month/day. */
export function formatFullDate(e: TimelineEvent): string {
  const yr = formatYear(e.year);
  if (e.month && e.month >= 1 && e.month <= 12) {
    const monthName = MONTHS[e.month - 1];
    if (e.day && e.day >= 1 && e.day <= 31) {
      return `${monthName} ${e.day}, ${yr}`;
    }
    return `${monthName} ${yr}`;
  }
  return yr;
}
