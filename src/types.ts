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
  starred: boolean;
}

export interface ViewState {
  /** The year located at the left edge (x = 0) of the timeline surface. */
  leftYear: number;
  /** Horizontal scale: screen pixels per year. */
  pxPerYear: number;
}
