import type { TimelineEvent, ViewState } from "./types";

const EVENTS_KEY = "timeline.events.v1";
const VIEW_KEY = "timeline.view.v1";
const META_KEY = "timeline.meta.v1";

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
        level: normalizeLevel(e),
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

/**
 * Resolve an event's importance level, migrating the old boolean `starred`
 * field: starred → L2 (still shown when zoomed out), unstarred → L5.
 */
function normalizeLevel(e: { level?: unknown; starred?: unknown }): number {
  const lvl = Number(e.level);
  if (Number.isInteger(lvl) && lvl >= 1 && lvl <= 6) return lvl;
  return e.starred ? 2 : 5;
}

/** Last time the local event data changed (epoch ms) — used for sync. */
export function loadUpdatedAt(): number {
  try {
    const meta = JSON.parse(localStorage.getItem(META_KEY) || "{}");
    return Number(meta.updatedAt) || 0;
  } catch {
    return 0;
  }
}

export function saveUpdatedAt(updatedAt: number): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify({ updatedAt }));
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
