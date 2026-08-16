import type { TimelineEvent, ViewState } from "./types";

// Zoom limits (pixels per year). MAX is high enough that the axis can label
// single years (niceStep === 1), which is when L6 becomes visible; MIN keeps
// L1 visible even at maximum zoom-out.
export const MIN_PX_PER_YEAR = 0.1;
export const MAX_PX_PER_YEAR = 200;

export function clampScale(pxPerYear: number): number {
  return Math.min(MAX_PX_PER_YEAR, Math.max(MIN_PX_PER_YEAR, pxPerYear));
}

// ---------------------------------------------------------------------------
// Importance levels
// ---------------------------------------------------------------------------
// An event's level says how long it stayed historically significant. A level
// is shown only once its cadence (its span in years) occupies enough screen
// space to be resolvable — see LEVEL_VISIBLE_PX / levelVisible. So L2 (1
// century) appears only once a century spans a comfortable distance on screen,
// L6 (1 year) only when a single year does, etc.
export const LEVELS = [1, 2, 3, 4, 5, 6];
export const DEFAULT_LEVEL = 4;

export const LEVEL_YEARS: Record<number, number> = {
  1: 1000,
  2: 100,
  3: 50,
  4: 25,
  5: 10,
  6: 1,
};

export const LEVEL_SPAN_LABEL: Record<number, string> = {
  1: "1000 years",
  2: "1 century",
  3: "50 years",
  4: "25 years",
  5: "10 years",
  6: "1 year",
};

// Warm (important) → cool (minor) so weight reads at a glance.
export const LEVEL_COLOR: Record<number, string> = {
  1: "#ff6b6b",
  2: "#ff9f45",
  3: "#ffcf4a",
  4: "#5fd0a0",
  5: "#5aa6e6",
  6: "#93a1b0",
};

// A level is shown once its cadence occupies at least this many pixels on
// screen — i.e. that time unit is comfortably resolvable. This is deliberately
// decoupled from the axis tick step so that denser year labels (see
// TICK_TARGET_PX) don't pull minor events in early. 96px reproduces the tuning
// from before the tick ladder was made denser.
export const LEVEL_VISIBLE_PX = 96;

/** Is an event of this importance level visible at the current zoom? */
export function levelVisible(level: number, view: ViewState): boolean {
  const span = LEVEL_YEARS[level] ?? LEVEL_YEARS[DEFAULT_LEVEL];
  return span * view.pxPerYear >= LEVEL_VISIBLE_PX;
}

/**
 * The least-important level currently visible (largest L number that passes),
 * or 0 if even L1 is hidden (extreme zoom-out).
 */
export function floorVisibleLevel(view: ViewState): number {
  for (let l = 6; l >= 1; l--) {
    if (levelVisible(l, view)) return l;
  }
  return 0;
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

// How far past the present the right edge may scroll, and how far back the left
// edge may go. The future allowance shrinks with zoom so "now" stays near the
// right edge instead of leaving a big empty gap.
export const FUTURE_LIMIT_FRACTION = 0.15;
export const FUTURE_LIMIT_MAX_YEARS = 80;
export const PAST_LIMIT_YEAR = -12000;

/** Constrain leftYear so the view can't scroll too far into the future/past. */
export function clampView(
  view: ViewState,
  width: number,
  presentYear: number,
): ViewState {
  if (width <= 0) return view;
  const span = width / view.pxPerYear;
  const maxFuture = Math.min(span * FUTURE_LIMIT_FRACTION, FUTURE_LIMIT_MAX_YEARS);
  const maxLeftYear = presentYear + maxFuture - span; // right edge at present + margin
  let leftYear = Math.min(view.leftYear, maxLeftYear);
  if (leftYear < PAST_LIMIT_YEAR) leftYear = PAST_LIMIT_YEAR;
  return { ...view, leftYear };
}

// Axis tick steps. A fairly dense ladder (~2–2.5x between rungs) so year
// labels appear as soon as there's room to draw them, instead of jumping
// straight from 5-year ticks to 1-year ticks and leaving a wide dead zone
// where the axis is stuck at 5. The 25 / 250 / 2500 rungs are kept so the axis
// still lands on the 25-year (L4) cadence when those events are the finest shown.
const NICE_STEPS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000];

// Aim for a label roughly every ~52px. Small enough that individual years
// resolve while there's still plenty of space, and that even the widest sub-band
// (~2.5x this) keeps several labels across the screen — never just two at the
// far edges — without labels overlapping.
export const TICK_TARGET_PX = 52;

/** Choose a "nice" year interval so ticks land roughly every `targetPx` pixels. */
export function niceStep(view: ViewState, targetPx = TICK_TARGET_PX): number {
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
  width: number;
}

export const CARD_MIN_W = 54;
export const CARD_MAX_W = 320;

// Horizontal chrome a card adds around its text: border (1px each side) +
// padding (7px each side) = 16px, plus a small slack so the last glyph never
// clips into an ellipsis.
const CARD_CHROME = 20;

const TITLE_FONT =
  '650 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const YEAR_FONT =
  '400 9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

let measureCtx: CanvasRenderingContext2D | null | undefined;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx === undefined) {
    measureCtx =
      typeof document !== "undefined"
        ? document.createElement("canvas").getContext("2d")
        : null;
  }
  return measureCtx;
}

/**
 * Width a card needs to show its title (and year) on one line, clamped between
 * CARD_MIN_W and CARD_MAX_W. Sizes to content so short titles aren't truncated.
 */
export function estimateCardWidth(event: TimelineEvent): number {
  const title = event.title || "(untitled)";
  const year = formatYear(event.year);
  const ctx = getMeasureCtx();
  let titleW: number;
  let yearW: number;
  const yearLine = `${year} · L4`; // year plus the muted level footnote
  if (ctx) {
    ctx.font = TITLE_FONT;
    titleW = ctx.measureText(title).width;
    ctx.font = YEAR_FONT;
    yearW = ctx.measureText(yearLine).width;
  } else {
    titleW = title.length * 7;
    yearW = yearLine.length * 6;
  }
  const content = Math.max(titleW, yearW);
  return Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, Math.ceil(content) + CARD_CHROME));
}

/**
 * Assign events to stacked lanes above the axis. Vertical position encodes
 * importance: the least-important visible level sits nearest the axis (lane 0)
 * and the most-important floats highest, "overarching" the rest. Levels are
 * processed from least to most important, and each level's cards are packed
 * into as many sub-lanes as needed to avoid horizontal overlap, always placed
 * strictly above the previous (less-important) level's lanes. Each card is
 * sized to its own content width.
 */
export function layoutEvents(
  events: TimelineEvent[],
  view: ViewState,
  width: number,
): PlacedEvent[] {
  const visible = events
    .map((event) => ({
      event,
      x: xOfYear(event.year, view),
      w: estimateCardWidth(event),
    }))
    .filter((p) => p.x > -(p.w + 60) && p.x < width + (p.w + 60));

  const gap = 8;
  const placed: PlacedEvent[] = [];
  // Higher L number = less important = nearer the axis, so process levels in
  // descending order and stack each above the last.
  const levels = [...new Set(visible.map((p) => p.event.level))].sort((a, b) => b - a);
  let laneFloor = 0;
  for (const level of levels) {
    const group = visible
      .filter((p) => p.event.level === level)
      .sort((a, b) => a.x - b.x);
    const laneEnds: number[] = []; // right edge (x) occupied per sub-lane
    for (const p of group) {
      const left = p.x - p.w / 2;
      let sub = laneEnds.findIndex((end) => left > end + gap);
      if (sub === -1) {
        sub = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[sub] = p.x + p.w / 2;
      placed.push({ event: p.event, x: p.x, lane: laneFloor + sub, width: p.w });
    }
    laneFloor += laneEnds.length;
  }
  return placed;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Parse a month from either a number (1-12) or a name prefix ("aug", "Aug",
 * "August"). Returns { valid: true } with no month for empty input, a month
 * number when it resolves, or { valid: false } when it can't.
 */
export function parseMonth(input: string): { month?: number; valid: boolean } {
  const s = input.trim();
  if (!s) return { valid: true };
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n >= 1 && n <= 12 ? { month: n, valid: true } : { valid: false };
  }
  const lc = s.toLowerCase();
  const idx = MONTHS.findIndex((m) => m.toLowerCase().startsWith(lc));
  return idx >= 0 ? { month: idx + 1, valid: true } : { valid: false };
}

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
