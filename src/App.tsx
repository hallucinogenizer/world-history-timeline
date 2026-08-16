import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TimelineEvent, ViewState } from "./types";
import {
  cryptoId,
  loadEvents,
  loadView,
  saveEvents,
  saveView,
} from "./storage";
import {
  computeTicks,
  formatFullDate,
  formatYear,
  formatYearShort,
  isStarOnly,
  layoutEvents,
  panBy,
  visibleSpanYears,
  xOfYear,
  zoomAround,
} from "./timeline";

const CARD_W = 150;
const LANE_H = 62;
const AXIS_FRAC = 0.68; // axis vertical position as fraction of surface height

export default function App() {
  const [events, setEvents] = useState<TimelineEvent[]>(() => loadEvents());
  const [view, setView] = useState<ViewState | null>(() => loadView());
  const [size, setSize] = useState({ width: 0, height: 0 });

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TimelineEvent | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gesture = useRef<{ cx: number; dist: number } | null>(null);
  const down = useRef<{ x: number; y: number; moved: boolean; eventId: string | null } | null>(null);

  // Measure the surface and react to orientation / window changes.
  useLayoutEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const update = () =>
      setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Initialise the default view once we know the surface width: present year
  // near the right edge, showing roughly the last few centuries.
  useEffect(() => {
    if (view || size.width === 0) return;
    const present = new Date().getFullYear();
    const pxPerYear = 5;
    setView({ leftYear: present - (size.width * 0.82) / pxPerYear, pxPerYear });
  }, [view, size.width]);

  useEffect(() => saveEvents(events), [events]);
  useEffect(() => {
    if (view) saveView(view);
  }, [view]);

  // Non-passive wheel handler so we can zoom (and prevent page scroll).
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const factor = Math.exp(-e.deltaY * 0.0016);
      setView((v) => (v ? zoomAround(v, x, factor) : v));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const rebaseline = useCallback(() => {
    const pts = [...pointers.current.values()];
    if (pts.length === 0) {
      gesture.current = null;
      return;
    }
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const dist = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { cx, dist };
  }, []);

  const relX = (clientX: number) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    return clientX - rect.left;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: relX(e.clientX), y: e.clientY });
    const hit = (e.target as Element).closest?.("[data-event-id]");
    down.current = {
      x: relX(e.clientX),
      y: e.clientY,
      moved: false,
      eventId: hit?.getAttribute("data-event-id") ?? null,
    };
    rebaseline();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: relX(e.clientX), y: e.clientY });

    if (down.current) {
      const dx = relX(e.clientX) - down.current.x;
      const dy = e.clientY - down.current.y;
      if (Math.hypot(dx, dy) > 6) down.current.moved = true;
    }

    const pts = [...pointers.current.values()];
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const dist = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    const g = gesture.current;
    if (!g) {
      rebaseline();
      return;
    }
    const dcx = cx - g.cx;
    const factor = pts.length >= 2 && g.dist > 0 && dist > 0 ? dist / g.dist : 1;
    setView((v) => (v ? panBy(zoomAround(v, cx, factor), dcx) : v));
    gesture.current = { cx, dist };
  };

  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    // A tap (little movement, single pointer) on an event opens its details.
    if (down.current && !down.current.moved && pointers.current.size === 0) {
      if (down.current.eventId) setSelectedId(down.current.eventId);
    }
    if (pointers.current.size === 0) down.current = null;
    rebaseline();
  };

  const zoomButton = (factor: number) => {
    if (!view || size.width === 0) return;
    setView((v) => (v ? zoomAround(v, size.width / 2, factor) : v));
  };

  const goToPresent = () => {
    if (size.width === 0) return;
    const present = new Date().getFullYear();
    const pxPerYear = 5;
    setView({ leftYear: present - (size.width * 0.82) / pxPerYear, pxPerYear });
  };

  const upsertEvent = (ev: TimelineEvent) => {
    setEvents((prev) => {
      const idx = prev.findIndex((p) => p.id === ev.id);
      if (idx === -1) return [...prev, ev];
      const next = prev.slice();
      next[idx] = ev;
      return next;
    });
  };

  const deleteEvent = (id: string) => {
    setEvents((prev) => prev.filter((p) => p.id !== id));
    setSelectedId(null);
  };

  const toggleStar = (id: string) => {
    setEvents((prev) =>
      prev.map((p) => (p.id === id ? { ...p, starred: !p.starred } : p)),
    );
  };

  const selected = events.find((e) => e.id === selectedId) ?? null;
  const starOnly = view ? isStarOnly(size.width, view) : false;
  const shownEvents = starOnly ? events.filter((e) => e.starred) : events;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          World History Timeline
        </div>
        <button
          className="btn btn-primary"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          + Add Event
        </button>
      </header>

      <div className="surface-wrap">
        <div
          ref={surfaceRef}
          className="surface"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          {view && size.width > 0 && (
            <TimelineCanvas
              events={shownEvents}
              view={view}
              width={size.width}
              height={size.height}
            />
          )}

          {events.length === 0 && (
            <div className="empty-hint">
              <div className="empty-title">Your timeline is empty</div>
              <div className="empty-sub">
                Tap <strong>+ Add Event</strong> to place your first moment in
                history.
              </div>
            </div>
          )}

          {starOnly && (
            <div className="badge">★ Zoomed out — showing starred events only</div>
          )}

          <div className="zoom-controls">
            <button className="btn round" onClick={() => zoomButton(1.6)} aria-label="Zoom in">
              +
            </button>
            <button className="btn round" onClick={() => zoomButton(1 / 1.6)} aria-label="Zoom out">
              −
            </button>
            <button className="btn round wide" onClick={goToPresent} aria-label="Go to present">
              Now
            </button>
          </div>
        </div>
      </div>

      {formOpen && (
        <EventForm
          initial={editing}
          onCancel={() => setFormOpen(false)}
          onSave={(ev) => {
            upsertEvent(ev);
            setFormOpen(false);
          }}
        />
      )}

      {selected && (
        <EventDetail
          event={selected}
          onClose={() => setSelectedId(null)}
          onToggleStar={() => toggleStar(selected.id)}
          onEdit={() => {
            setEditing(selected);
            setSelectedId(null);
            setFormOpen(true);
          }}
          onDelete={() => deleteEvent(selected.id)}
        />
      )}
    </div>
  );
}

function TimelineCanvas({
  events,
  view,
  width,
  height,
}: {
  events: TimelineEvent[];
  view: ViewState;
  width: number;
  height: number;
}) {
  const axisY = height * AXIS_FRAC;
  const ticks = computeTicks(width, view);
  const placed = layoutEvents(events, view, width, CARD_W);
  const maxLanes = Math.max(1, Math.floor((axisY - 16) / LANE_H));

  const present = new Date().getFullYear();
  const presentX = xOfYear(present, view);
  const showPresent = presentX >= 0 && presentX <= width;
  const spanLabel = describeSpan(visibleSpanYears(width, view));

  return (
    <>
      {/* faint vertical gridlines aligned with year ticks */}
      {ticks.map((t) => (
        <div
          key={`g${t.year}`}
          className="gridline"
          style={{ left: t.x, height: axisY }}
        />
      ))}

      {/* the axis line */}
      <div className="axis" style={{ top: axisY }} />

      {/* present-day marker */}
      {showPresent && (
        <div className="present" style={{ left: presentX, height }}>
          <span className="present-label">now</span>
        </div>
      )}

      {/* year tick marks + labels below the axis */}
      {ticks.map((t) => (
        <div key={`t${t.year}`}>
          <div className="tick" style={{ left: t.x, top: axisY }} />
          <div className="tick-label" style={{ left: t.x, top: axisY + 12 }}>
            {formatYearShort(t.year)}
          </div>
        </div>
      ))}

      {/* events above the axis */}
      {placed.map((p) => {
        const lane = p.lane % maxLanes;
        const cardBottom = axisY - 16 - lane * LANE_H;
        return (
          <div key={p.event.id} data-event-id={p.event.id}>
            <div
              className="event-stem"
              style={{ left: p.x, top: cardBottom, height: axisY - cardBottom }}
            />
            <div className={`event-dot${p.event.starred ? " starred" : ""}`} style={{ left: p.x, top: axisY }} />
            <div
              className={`event-card${p.event.starred ? " starred" : ""}`}
              style={{ left: p.x - CARD_W / 2, top: cardBottom - 48, width: CARD_W }}
            >
              <div className="event-title">
                {p.event.starred && <span className="star">★</span>}
                {p.event.title || "(untitled)"}
              </div>
              <div className="event-year">{formatYear(p.event.year)}</div>
            </div>
          </div>
        );
      })}

      <div className="span-label">{spanLabel}</div>
    </>
  );
}

function describeSpan(years: number): string {
  const y = Math.round(years);
  if (y >= 2000) return `Viewing ~${(y / 1000).toFixed(1)}k years`;
  return `Viewing ~${y} years`;
}

function EventForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: TimelineEvent | null;
  onCancel: () => void;
  onSave: (e: TimelineEvent) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [era, setEra] = useState<"AD" | "BC">(
    initial ? (initial.year < 0 ? "BC" : "AD") : "AD",
  );
  const [yearStr, setYearStr] = useState(
    initial ? String(Math.abs(initial.year)) : "",
  );
  const [monthStr, setMonthStr] = useState(initial?.month ? String(initial.month) : "");
  const [dayStr, setDayStr] = useState(initial?.day ? String(initial.day) : "");
  const [starred, setStarred] = useState(initial?.starred ?? false);
  const [error, setError] = useState("");

  const submit = () => {
    const yearAbs = parseInt(yearStr, 10);
    if (!title.trim()) return setError("Please enter a title.");
    if (!Number.isFinite(yearAbs) || yearAbs < 0) return setError("Please enter a valid year.");
    const year = era === "BC" ? -yearAbs : yearAbs;

    const month = monthStr ? parseInt(monthStr, 10) : undefined;
    if (month !== undefined && (month < 1 || month > 12))
      return setError("Month must be between 1 and 12.");
    const day = dayStr ? parseInt(dayStr, 10) : undefined;
    if (day !== undefined && (day < 1 || day > 31))
      return setError("Day must be between 1 and 31.");
    if (day !== undefined && month === undefined)
      return setError("Add a month before a day.");

    onSave({
      id: initial?.id ?? cryptoId(),
      title: title.trim(),
      description: description.trim(),
      year,
      month,
      day,
      starred,
    });
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{initial ? "Edit event" : "Add event"}</h2>

        <label className="field">
          <span>Title</span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Fall of Constantinople"
          />
        </label>

        <label className="field">
          <span>Description</span>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional details"
          />
        </label>

        <div className="field-row">
          <label className="field grow">
            <span>Year</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={yearStr}
              onChange={(e) => setYearStr(e.target.value)}
              placeholder="1453"
            />
          </label>
          <label className="field">
            <span>Era</span>
            <select value={era} onChange={(e) => setEra(e.target.value as "AD" | "BC")}>
              <option value="AD">AD / CE</option>
              <option value="BC">BC / BCE</option>
            </select>
          </label>
        </div>

        <div className="field-row">
          <label className="field grow">
            <span>Month (optional)</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={12}
              value={monthStr}
              onChange={(e) => setMonthStr(e.target.value)}
              placeholder="—"
            />
          </label>
          <label className="field grow">
            <span>Day (optional)</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={31}
              value={dayStr}
              onChange={(e) => setDayStr(e.target.value)}
              placeholder="—"
            />
          </label>
        </div>

        <label className="field-check">
          <input
            type="checkbox"
            checked={starred}
            onChange={(e) => setStarred(e.target.checked)}
          />
          <span>★ Star this event (stays visible when zoomed out)</span>
        </label>

        {error && <div className="error">{error}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function EventDetail({
  event,
  onClose,
  onToggleStar,
  onEdit,
  onDelete,
}: {
  event: TimelineEvent;
  onClose: () => void;
  onToggleStar: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="detail-date">{formatFullDate(event)}</div>
        <h2 className="detail-title">
          {event.starred && <span className="star">★</span>}
          {event.title || "(untitled)"}
        </h2>
        {event.description ? (
          <p className="detail-desc">{event.description}</p>
        ) : (
          <p className="detail-desc muted">No description.</p>
        )}

        <div className="modal-actions">
          <button className="btn danger" onClick={onDelete}>
            Delete
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onToggleStar}>
            {event.starred ? "Unstar" : "★ Star"}
          </button>
          <button className="btn" onClick={onEdit}>
            Edit
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
