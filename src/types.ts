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
  /** The year located at the left edge (x = 0) of the timeline surface. */
  leftYear: number;
  /** Horizontal scale: screen pixels per year. */
  pxPerYear: number;
}
