import type { TimelineEvent, ViewState } from "./types";

const EVENTS_KEY = "timeline.events.v1";
const VIEW_KEY = "timeline.view.v1";

export function loadEvents(): TimelineEvent[] {
  try {
    const raw = localStorage.getItem(EVENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Basic shape guard so a corrupt entry can't crash the app.
    return parsed
      .filter((e) => e && typeof e.year === "number")
      .map((e) => ({
        id: String(e.id ?? cryptoId()),
        title: String(e.title ?? ""),
        description: String(e.description ?? ""),
        year: Number(e.year),
        month: e.month != null ? Number(e.month) : undefined,
        day: e.day != null ? Number(e.day) : undefined,
        starred: Boolean(e.starred),
      }));
  } catch {
    return [];
  }
}

export function saveEvents(events: TimelineEvent[]): void {
  try {
    localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  } catch {
    /* storage full or unavailable — ignore for a personal offline app */
  }
}

export function loadView(): ViewState | null {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.leftYear === "number" && typeof v?.pxPerYear === "number") {
      return { leftYear: v.leftYear, pxPerYear: v.pxPerYear };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveView(view: ViewState): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    /* ignore */
  }
}

export function cryptoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}
