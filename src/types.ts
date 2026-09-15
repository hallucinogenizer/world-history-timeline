export interface TimelineEvent {
  id: string;
  title: string;
  description: string;
  /** Signed year. Negative = BC (e.g. -500 => 500 BC). */
  year: number;
  /** Optional month 1-12. */
  month?: number;
  /** Optional day 1-31. Only meaningful when month is set. */
  day?: number;
  /**
   * Importance level 1-6, expressed as how long the event stayed significant.
   * L1 = 1000 years (most important, visible even when zoomed far out) …
   * L6 = 1 year (least important, visible only at year-level zoom).
   */
  level: number;
}

export interface ViewState {
  /** The year at the start of the time axis — the left edge in horizontal
   * mode, the top edge in vertical mode. */
  leftYear: number;
  /** Scale along the time axis: screen pixels per year. */
  pxPerYear: number;
}

/**
 * Which way time runs across the screen. "auto" follows the device: vertical
 * while the screen is taller than it is wide, horizontal once it's turned.
 */
export type Orientation = "auto" | "horizontal" | "vertical";

export interface Settings {
  orientation: Orientation;
  /** Whether a flick keeps the timeline coasting after the finger lifts. */
  inertiaEnabled: boolean;
  /** How far a flick carries, 1 (barely) to 10 (a long way). */
  inertiaGlide: number;
  /** How hard you have to flick to set it off, 1 (a nudge) to 10 (a shove). */
  inertiaForce: number;
}
