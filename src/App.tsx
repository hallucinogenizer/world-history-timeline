import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TimelineEvent, ViewState } from "./types";
import {
  cryptoId,
  loadEvents,
  loadUpdatedAt,
  loadView,
  saveEvents,
  saveUpdatedAt,
  saveView,
} from "./storage";
import { pullRemote, pushRemote, syncEnabled } from "./sync";
import {
  clampView,
  computeTicks,
  DEFAULT_LEVEL,
  floorVisibleLevel,
  formatFullDate,
  formatYear,
  formatYearShort,
  layoutEvents,
  levelVisible,
  LEVEL_COLOR,
  LEVEL_SPAN_LABEL,
  LEVELS,
  panBy,
  parseMonth,
  visibleSpanYears,
  xOfYear,
  zoomAround,
} from "./timeline";

const LANE_H = 40; // vertical spacing between stacked event lanes
const CARD_H = 32; // event card height
const AXIS_GAP = 10; // gap between the axis and the lowest card lane
const AXIS_FRAC = 0.7; // axis vertical position as fraction of surface height
const DRAG_THRESHOLD = 6; // px of movement before a touch counts as a pan, not a tap

export default function App() {
  const [events, setEvents] = useState<TimelineEvent[]>(() => loadEvents());
  const [updatedAt, setUpdatedAt] = useState<number>(() => loadUpdatedAt());
  const [view, setView] = useState<ViewState | null>(() => loadView());
  const [size, setSize] = useState({ width: 0, height: 0 });

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TimelineEvent | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gesture = useRef<{ cx: number; dist: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  // True once the current gesture has moved far enough to be a pan/pinch.
  // Read by an event's onClick so a drag that ends on a card doesn't open it.
  const dragged = useRef(false);

  // Sync bookkeeping (kept in refs to read fresh values inside async/timeout).
  const eventsRef = useRef(events);
  const updatedAtRef = useRef(updatedAt);
  const lastPushed = useRef(0);
  const pullDone = useRef(false);
  const pushTimer = useRef<number | null>(null);
  eventsRef.current = events;
  updatedAtRef.current = updatedAt;

  const sizeRef = useRef(size);
  sizeRef.current = size;
  const clampedInit = useRef(false);
  const presentYear = new Date().getFullYear();
  const clamp = useCallback(
    (v: ViewState) => clampView(v, sizeRef.current.width, presentYear),
    [presentYear],
  );

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
    if (size.width === 0) return;
    if (!view) {
      const pxPerYear = 5;
      setView(
        clamp({
          leftYear: presentYear - (size.width * 0.82) / pxPerYear,
          pxPerYear,
        }),
      );
      clampedInit.current = true;
    } else if (!clampedInit.current) {
      clampedInit.current = true;
      setView((v) => (v ? clamp(v) : v));
    }
  }, [view, size.width, clamp, presentYear]);

  useEffect(() => saveEvents(events), [events]);
  useEffect(() => saveUpdatedAt(updatedAt), [updatedAt]);
  useEffect(() => {
    if (view) saveView(view);
  }, [view]);

  // Debounced push of the current snapshot to the remote store.
  const schedulePush = useCallback(() => {
    if (!syncEnabled) return;
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = window.setTimeout(async () => {
      const snap = {
        events: eventsRef.current,
        updatedAt: updatedAtRef.current,
      };
      try {
        await pushRemote(snap);
        lastPushed.current = snap.updatedAt;
      } catch {
        /* offline — the next change (or next launch) will retry */
      }
    }, 1200);
  }, []);

  // On launch: pull the remote snapshot and reconcile with local (newest wins).
  useEffect(() => {
    if (!syncEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        const remote = await pullRemote();
        if (cancelled) return;
        if (remote && remote.updatedAt > updatedAtRef.current) {
          setEvents(remote.events);
          setUpdatedAt(remote.updatedAt);
          lastPushed.current = remote.updatedAt;
        } else {
          lastPushed.current = remote ? remote.updatedAt : 0;
          if (updatedAtRef.current > lastPushed.current) schedulePush();
        }
      } catch {
        /* offline — stay on local data */
      } finally {
        pullDone.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [schedulePush]);

  // After a local change, push it up (once the initial pull has resolved).
  useEffect(() => {
    if (!syncEnabled || !pullDone.current) return;
    if (updatedAt <= lastPushed.current) return;
    schedulePush();
  }, [events, updatedAt, schedulePush]);

  // Non-passive wheel handler so we can zoom (and prevent page scroll).
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const factor = Math.exp(-e.deltaY * 0.0016);
      setView((v) => (v ? clamp(zoomAround(v, x, factor)) : v));
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
    pointers.current.set(e.pointerId, { x: relX(e.clientX), y: e.clientY });
    if (pointers.current.size === 1) {
      dragged.current = false;
      start.current = { x: relX(e.clientX), y: e.clientY };
    }
    rebaseline();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: relX(e.clientX), y: e.clientY });

    const pts = [...pointers.current.values()];
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const dist = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;

    // Ignore sub-threshold jitter from a single finger so a tap stays a tap.
    if (!dragged.current && pts.length < 2) {
      const s = start.current;
      if (s && Math.hypot(cx - s.x, cy - s.y) <= DRAG_THRESHOLD) return;
    }
    dragged.current = true;

    const g = gesture.current;
    if (!g) {
      rebaseline();
      return;
    }
    const dcx = cx - g.cx;
    const factor = pts.length >= 2 && g.dist > 0 && dist > 0 ? dist / g.dist : 1;
    setView((v) => (v ? clamp(panBy(zoomAround(v, cx, factor), dcx)) : v));
    gesture.current = { cx, dist };
  };

  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) start.current = null;
    rebaseline();
  };

  // Opening an event's details — skipped if the gesture was a drag/pan.
  const selectEvent = (id: string) => {
    if (!dragged.current) setSelectedId(id);
  };

  const zoomButton = (factor: number) => {
    if (!view || size.width === 0) return;
    setView((v) => (v ? clamp(zoomAround(v, size.width / 2, factor)) : v));
  };

  const goToPresent = () => {
    if (size.width === 0) return;
    const pxPerYear = 5;
    setView(
      clamp({
        leftYear: presentYear - (size.width * 0.82) / pxPerYear,
        pxPerYear,
      }),
    );
  };

  const upsertEvent = (ev: TimelineEvent) => {
    setEvents((prev) => {
      const idx = prev.findIndex((p) => p.id === ev.id);
      if (idx === -1) return [...prev, ev];
      const next = prev.slice();
      next[idx] = ev;
      return next;
    });
    setUpdatedAt(Date.now());
  };

  const deleteEvent = (id: string) => {
    setEvents((prev) => prev.filter((p) => p.id !== id));
    setUpdatedAt(Date.now());
    setSelectedId(null);
  };

  const selected = events.find((e) => e.id === selectedId) ?? null;
  const shownEvents = view
    ? events.filter((e) => levelVisible(e.level, view))
    : [];
  const hiddenCount = events.length - shownEvents.length;
  const floor = view ? floorVisibleLevel(view) : 6;

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  return (
    <div className="app">
      {!fullscreen && (
        <header className="topbar">
          <div className="brand">
            <span className="brand-dot" />
            World History Timeline
          </div>
          <div className="topbar-actions">
            <button
              className="btn round-sm"
              onClick={() => setFullscreen(true)}
              aria-label="Full screen"
              title="Full screen"
            >
              ⛶
            </button>
            <button className="btn btn-primary" onClick={openAdd}>
              + Add Event
            </button>
          </div>
        </header>
      )}

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
              onSelect={selectEvent}
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

          {hiddenCount > 0 && (
            <div className="badge">
              {floor >= 1
                ? `Showing events significant for ≥ ${LEVEL_SPAN_LABEL[floor]} · ${hiddenCount} hidden`
                : `Zoom in to reveal events`}
            </div>
          )}

          {fullscreen && (
            <div className="fs-controls">
              <button
                className="btn round"
                onClick={() => setFullscreen(false)}
                aria-label="Exit full screen"
                title="Exit full screen"
              >
                ⛶
              </button>
              <button
                className="btn btn-primary round wide"
                onClick={openAdd}
                aria-label="Add event"
              >
                + Event
              </button>
            </div>
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
  onSelect,
}: {
  events: TimelineEvent[];
  view: ViewState;
  width: number;
  height: number;
  onSelect: (id: string) => void;
}) {
  const axisY = height * AXIS_FRAC;
  const ticks = computeTicks(width, view);
  const placed = layoutEvents(events, view, width);
  const maxLanes = Math.max(1, Math.floor((axisY - AXIS_GAP) / LANE_H));

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
        const cardBottom = axisY - AXIS_GAP - lane * LANE_H;
        return (
          <div
            key={p.event.id}
            data-event-id={p.event.id}
            onClick={() => onSelect(p.event.id)}
          >
            <div
              className="event-stem"
              style={{
                left: p.x,
                top: cardBottom,
                height: axisY - cardBottom,
                background: LEVEL_COLOR[p.event.level],
              }}
            />
            <div
              className="event-dot"
              style={{
                left: p.x,
                top: axisY,
                background: LEVEL_COLOR[p.event.level],
                boxShadow: `0 0 8px ${LEVEL_COLOR[p.event.level]}cc`,
              }}
            />
            <div
              className="event-card"
              style={{
                left: p.x - p.width / 2,
                top: cardBottom - CARD_H - 2,
                width: p.width,
                height: CARD_H,
                borderColor: `${LEVEL_COLOR[p.event.level]}66`,
              }}
            >
              <div className="event-title">{p.event.title || "(untitled)"}</div>
              <div className="event-year">
                {formatYear(p.event.year)}
                <span className="event-year-lvl"> · L{p.event.level}</span>
              </div>
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
  const [level, setLevel] = useState<number>(initial?.level ?? DEFAULT_LEVEL);
  const [error, setError] = useState("");

  const submit = () => {
    const yearAbs = parseInt(yearStr, 10);
    if (!title.trim()) return setError("Please enter a title.");
    if (!Number.isFinite(yearAbs) || yearAbs < 0) return setError("Please enter a valid year.");
    const year = era === "BC" ? -yearAbs : yearAbs;

    const parsedMonth = parseMonth(monthStr);
    if (!parsedMonth.valid)
      return setError('Month must be 1–12 or a name like "Aug".');
    const month = parsedMonth.month;
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
      level,
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
              type="text"
              value={monthStr}
              onChange={(e) => setMonthStr(e.target.value)}
              placeholder="e.g. 8 or Aug"
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

        <label className="field">
          <span>Importance — how long it stayed significant</span>
          <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                L{l} — significant for {LEVEL_SPAN_LABEL[l]}
              </option>
            ))}
          </select>
          <span className="hint">
            More significant events (L1–L2) stay visible when you zoom out;
            minor ones (L5–L6) appear only as you zoom in.
          </span>
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
  onEdit,
  onDelete,
}: {
  event: TimelineEvent;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="detail-date">{formatFullDate(event)}</div>
        <h2 className="detail-title">{event.title || "(untitled)"}</h2>
        <div
          className="level-chip"
          style={{
            color: LEVEL_COLOR[event.level],
            borderColor: `${LEVEL_COLOR[event.level]}66`,
          }}
        >
          <span className="level-chip-dot" style={{ background: LEVEL_COLOR[event.level] }} />
          L{event.level} · significant for {LEVEL_SPAN_LABEL[event.level]}
        </div>
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
