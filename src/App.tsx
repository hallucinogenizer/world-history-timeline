import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Orientation, Settings, TimelineEvent, ViewState } from "./types";
import {
  cryptoId,
  loadEvents,
  loadSettings,
  loadUpdatedAt,
  loadView,
  saveEvents,
  saveSettings,
  saveUpdatedAt,
  saveView,
} from "./storage";
import { pullRemote, pushRemote, syncEnabled } from "./sync";
import {
  CARD_H,
  clampView,
  computeTicks,
  DEFAULT_LEVEL,
  floorVisibleLevel,
  formatFullDate,
  formatYear,
  formatYearShort,
  layoutEvents,
  layoutEventsVertical,
  levelVisible,
  LEVEL_COLOR,
  matchesQuery,
  LEVEL_SPAN_LABEL,
  LEVELS,
  panBy,
  parseMonth,
  posOfYear,
  viewFocusedOn,
  visibleSpanYears,
  zoomAround,
} from "./timeline";
import type { PlacedEvent } from "./timeline";

const LANE_H = 40; // spacing between stacked event lanes (horizontal mode)
const AXIS_GAP = 10; // gap between the axis and the nearest card lane
const AXIS_FRAC = 0.7; // axis position as a fraction of the cross-axis size
const DRAG_THRESHOLD = 6; // px of movement before a touch counts as a pan, not a tap

// Flick-to-glide. Velocity is tracked in pixels per millisecond along the time
// axis, smoothed over the last few pointer samples so one jittery frame can't
// throw the throw. On release the glide decays exponentially with `tau` as its
// time constant, which lands it around v0 * tau pixels away.
const FLING_MAX_V = 4; // cap so a wild flick can't launch the view into orbit
const FLING_STOP_V = 0.015; // end the glide once it's slower than ~1px/frame
const FLING_IDLE_MS = 80; // a finger that paused before lifting doesn't throw
const VELOCITY_SMOOTH = 0.35; // weight of the newest sample in the average

// The two Settings dials, each 1-10, mapped onto the numbers the glide runs on.
// Both are tuned so 5 — the default — reproduces the feel they replaced.

/** Decay time constant in ms: how far a flick carries. */
export function flingTau(glide: number): number {
  return 100 + (glide - 1) * 60; // 100ms … 640ms
}

/** Velocity in px/ms a release must beat to count as a flick, not a stop. */
export function flingMinVelocity(force: number): number {
  return 0.02 + (force - 1) * 0.015; // a nudge … a shove
}

// Vertical mode: a fixed gutter left of the axis holds the year labels, and
// event cards sit in columns to its right — one wide column on a phone, more
// on a larger screen. V_RIGHT_GUTTER keeps those columns clear of the floating
// zoom controls.
const V_AXIS_X = 88;
const V_COL_GAP = 8;
const V_RIGHT_GUTTER = 100;

export default function App() {
  const [events, setEvents] = useState<TimelineEvent[]>(() => loadEvents());
  const [updatedAt, setUpdatedAt] = useState<number>(() => loadUpdatedAt());
  const [view, setView] = useState<ViewState | null>(() => loadView());
  const [size, setSize] = useState({ width: 0, height: 0 });

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TimelineEvent | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Temporary override: show every event regardless of the zoom-level filter.
  // Deliberately not persisted — it's a peek, not a preference.
  const [showAll, setShowAll] = useState(false);

  const surfaceRef = useRef<HTMLDivElement>(null);
  // Pointer positions in axis-relative terms: `main` runs along the time axis,
  // `cross` across it, so one set of gesture maths serves both orientations.
  const pointers = useRef<Map<number, { main: number; cross: number }>>(new Map());
  const gesture = useRef<{ center: number; dist: number } | null>(null);
  const start = useRef<{ main: number; cross: number } | null>(null);
  // True once the current gesture has moved far enough to be a pan/pinch.
  // Read by an event's onClick so a drag that ends on a card doesn't open it.
  const dragged = useRef(false);
  // Flick tracking: smoothed velocity along the time axis, when it was last
  // sampled, and the handle of the glide currently animating (if any).
  const velocity = useRef(0);
  // The glide's settings, in a ref so the animation callbacks stay stable.
  const fling = useRef({ enabled: true, tau: 0, minV: 0 });
  const lastSample = useRef(0);
  const glide = useRef<number | null>(null);

  // Sync bookkeeping (kept in refs to read fresh values inside async/timeout).
  const eventsRef = useRef(events);
  const updatedAtRef = useRef(updatedAt);
  const lastPushed = useRef(0);
  const pullDone = useRef(false);
  const pushTimer = useRef<number | null>(null);
  eventsRef.current = events;
  updatedAtRef.current = updatedAt;

  // "auto" follows the device: portrait reads vertically, landscape across.
  fling.current = {
    enabled: settings.inertiaEnabled,
    tau: flingTau(settings.inertiaGlide),
    minV: flingMinVelocity(settings.inertiaForce),
  };

  const vertical =
    settings.orientation === "auto"
      ? size.height > size.width
      : settings.orientation === "vertical";
  // Pixel length of the time axis: across the screen, or down it.
  const mainSpan = vertical ? size.height : size.width;

  const sizeRef = useRef(size);
  sizeRef.current = size;
  // The glide animates outside React's render cycle, so it needs the live view.
  const viewRef = useRef(view);
  viewRef.current = view;
  // Read inside stable callbacks (clamp, the wheel listener) so they don't have
  // to be rebuilt when the orientation or surface size changes.
  const mainSpanRef = useRef(mainSpan);
  mainSpanRef.current = mainSpan;
  const verticalRef = useRef(vertical);
  verticalRef.current = vertical;
  const clampedInit = useRef(false);
  const presentYear = new Date().getFullYear();
  const clamp = useCallback(
    (v: ViewState) => clampView(v, mainSpanRef.current, presentYear),
    [presentYear],
  );

  /** Halt any glide in progress. Returns whether one was actually running. */
  const stopGlide = useCallback(() => {
    if (glide.current === null) return false;
    cancelAnimationFrame(glide.current);
    glide.current = null;
    return true;
  }, []);

  // Coast on after a flick, shedding speed until it's imperceptible — or until
  // the view clamp stops it dead at the end of the timeline.
  const startGlide = useCallback(() => {
    const from = viewRef.current;
    if (!from) return;
    let current = from;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(now - last, 64); // a backgrounded tab shouldn't lurch
      last = now;
      const next = clamp(panBy(current, velocity.current * dt));
      const stalled = next.leftYear === current.leftYear;
      current = next;
      setView(next);
      velocity.current *= Math.exp(-dt / fling.current.tau);
      if (stalled || Math.abs(velocity.current) < FLING_STOP_V) {
        glide.current = null;
        return;
      }
      glide.current = requestAnimationFrame(step);
    };
    glide.current = requestAnimationFrame(step);
  }, [clamp]);

  useEffect(() => () => {
    stopGlide();
  }, [stopGlide]);

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
    if (mainSpan === 0) return;
    if (!view) {
      const pxPerYear = 5;
      setView(
        clamp({
          leftYear: presentYear - (mainSpan * 0.82) / pxPerYear,
          pxPerYear,
        }),
      );
      clampedInit.current = true;
    } else if (!clampedInit.current) {
      clampedInit.current = true;
      setView((v) => (v ? clamp(v) : v));
    }
  }, [view, mainSpan, clamp, presentYear]);

  // The axis changes length when the orientation flips, so the clamp has to be
  // re-applied against the new span.
  useEffect(() => {
    if (mainSpan === 0) return;
    setView((v) => (v ? clamp(v) : v));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vertical]);

  useEffect(() => saveSettings(settings), [settings]);

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
      stopGlide();
      const rect = el.getBoundingClientRect();
      const pos = verticalRef.current ? e.clientY - rect.top : e.clientX - rect.left;
      const factor = Math.exp(-e.deltaY * 0.0016);
      setView((v) => (v ? clamp(zoomAround(v, pos, factor)) : v));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [stopGlide]);

  const gestureOf = (pts: { main: number; cross: number }[]) => ({
    center: pts.reduce((sum, p) => sum + p.main, 0) / pts.length,
    crossCenter: pts.reduce((sum, p) => sum + p.cross, 0) / pts.length,
    dist:
      pts.length >= 2
        ? Math.hypot(pts[0].main - pts[1].main, pts[0].cross - pts[1].cross)
        : 0,
  });

  const rebaseline = useCallback(() => {
    const pts = [...pointers.current.values()];
    if (pts.length === 0) {
      gesture.current = null;
      return;
    }
    const g = gestureOf(pts);
    gesture.current = { center: g.center, dist: g.dist };
  }, []);

  const rel = (e: React.PointerEvent) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return vertical ? { main: y, cross: x } : { main: x, cross: y };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const caught = stopGlide();
    const p = rel(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1) {
      // A tap that catches a moving timeline should only stop it, not also
      // open whatever card happened to be under the finger.
      dragged.current = caught;
      start.current = p;
    }
    velocity.current = 0;
    lastSample.current = performance.now();
    rebaseline();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, rel(e));

    const pts = [...pointers.current.values()];
    const { center, crossCenter, dist } = gestureOf(pts);

    // Ignore sub-threshold jitter from a single finger so a tap stays a tap.
    if (!dragged.current && pts.length < 2) {
      const s = start.current;
      if (s && Math.hypot(center - s.main, crossCenter - s.cross) <= DRAG_THRESHOLD)
        return;
    }
    dragged.current = true;

    const g = gesture.current;
    if (!g) {
      rebaseline();
      return;
    }
    const dCenter = center - g.center;
    const factor = pts.length >= 2 && g.dist > 0 && dist > 0 ? dist / g.dist : 1;
    setView((v) => (v ? clamp(panBy(zoomAround(v, center, factor), dCenter)) : v));
    gesture.current = { center, dist };

    const now = performance.now();
    const dt = now - lastSample.current;
    lastSample.current = now;
    // A long gap means the finger was resting, so the throw starts over.
    velocity.current =
      dt > 0 && dt < 120
        ? velocity.current * (1 - VELOCITY_SMOOTH) + (dCenter / dt) * VELOCITY_SMOOTH
        : 0;
  };

  const endPointer = (e: React.PointerEvent, released: boolean) => {
    pointers.current.delete(e.pointerId);
    rebaseline();
    if (pointers.current.size > 0) {
      // Lifting one finger of a pinch re-centres the gesture; that jump isn't
      // a throw, so start measuring again from here.
      velocity.current = 0;
      lastSample.current = performance.now();
      return;
    }
    start.current = null;
    const idle = performance.now() - lastSample.current;
    if (
      fling.current.enabled &&
      released &&
      dragged.current &&
      idle < FLING_IDLE_MS &&
      Math.abs(velocity.current) > fling.current.minV
    ) {
      velocity.current = Math.max(-FLING_MAX_V, Math.min(FLING_MAX_V, velocity.current));
      startGlide();
    }
  };

  // Opening an event's details — skipped if the gesture was a drag/pan.
  const selectEvent = (id: string) => {
    if (!dragged.current) setSelectedId(id);
  };

  const zoomButton = (factor: number) => {
    stopGlide();
    if (!view || mainSpan === 0) return;
    setView((v) => (v ? clamp(zoomAround(v, mainSpan / 2, factor)) : v));
  };

  const goToPresent = () => {
    stopGlide();
    if (mainSpan === 0) return;
    const pxPerYear = 5;
    setView(
      clamp({
        leftYear: presentYear - (mainSpan * 0.82) / pxPerYear,
        pxPerYear,
      }),
    );
  };

  // Jump the timeline to an event — used by search results.
  const goToEvent = (ev: TimelineEvent) => {
    stopGlide();
    setSearchOpen(false);
    if (view && mainSpan > 0) setView(clamp(viewFocusedOn(ev, view, mainSpan)));
    setSelectedId(ev.id);
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
  // What the zoom level would show on its own, so the badge and the toggle can
  // still say how many events "View all" is pulling in.
  const inZoomCount = view
    ? events.filter((e) => levelVisible(e.level, view)).length
    : 0;
  const hiddenCount = events.length - inZoomCount;
  const shownEvents = view
    ? showAll
      ? events
      : events.filter((e) => levelVisible(e.level, view))
    : [];
  const floor = view ? floorVisibleLevel(view) : 6;

  // Room for lanes across the axis: stacked rows above it horizontally, card
  // columns beside it vertically.
  const laneSpace = vertical
    ? Math.max(0, size.width - V_AXIS_X - AXIS_GAP - V_RIGHT_GUTTER)
    : Math.max(0, size.height * AXIS_FRAC - AXIS_GAP);

  const { placed, overflow, colWidth } =
    view && mainSpan > 0
      ? vertical
        ? layoutEventsVertical(shownEvents, view, mainSpan, laneSpace)
        : layoutEvents(shownEvents, view, mainSpan, Math.max(1, Math.floor(laneSpace / LANE_H)))
      : { placed: [] as PlacedEvent[], overflow: 0, colWidth: 0 };

  // Two ways an event can be missing: its level is below the zoom threshold, or
  // this stretch of timeline is too crowded to give it a lane.
  const badgeText = showAll
    ? overflow > 0
      ? `Showing all ${events.length} events · ${overflow} too crowded to place`
      : `Showing all ${events.length} events`
    : floor >= 1
      ? `Showing events significant for ≥ ${LEVEL_SPAN_LABEL[floor]} · ${
          hiddenCount + overflow
        } hidden`
      : `Zoom in to reveal events`;

  const updateSettings = (patch: Partial<Settings>) =>
    setSettings((s) => ({ ...s, ...patch }));

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
              onClick={() => setSearchOpen(true)}
              aria-label="Search events"
              title="Search events"
            >
              <SearchIcon />
            </button>
            <button
              className="btn round-sm"
              onClick={() => setFullscreen(true)}
              aria-label="Full screen"
              title="Full screen"
            >
              ⛶
            </button>
            {/* Adding events and changing settings are rare, so they live
                behind a menu rather than taking up the bar. */}
            <div className="menu-wrap">
              <button
                className="btn round-sm"
                onClick={() => setMenuOpen((open) => !open)}
                aria-label="More"
                aria-expanded={menuOpen}
                title="More"
              >
                ⋮
              </button>
              {menuOpen && (
                <>
                  <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
                  <div className="menu" role="menu">
                    <button
                      className="menu-item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        openAdd();
                      }}
                    >
                      Add event
                    </button>
                    <button
                      className="menu-item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        setSettingsOpen(true);
                      }}
                    >
                      Settings
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>
      )}

      <div className="surface-wrap">
        <div
          ref={surfaceRef}
          className="surface"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endPointer(e, true)}
          onPointerCancel={(e) => endPointer(e, false)}
        >
          {view && size.width > 0 && (
            <TimelineCanvas
              placed={placed}
              view={view}
              width={size.width}
              height={size.height}
              vertical={vertical}
              colWidth={colWidth}
              onSelect={selectEvent}
            />
          )}

          {events.length === 0 && (
            <div className="empty-hint">
              <div className="empty-title">Your timeline is empty</div>
              <div className="empty-sub">
                Tap <strong>⋮ → Add event</strong> to place your first moment in
                history.
              </div>
            </div>
          )}

          {(showAll || hiddenCount + overflow > 0) && events.length > 0 && (
            <div className={showAll ? "badge on" : "badge"}>{badgeText}</div>
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
            </div>
          )}

          <div className="zoom-controls">
            <button className="btn round" onClick={() => zoomButton(1.6)} aria-label="Zoom in">
              +
            </button>
            <button className="btn round" onClick={() => zoomButton(1 / 1.6)} aria-label="Zoom out">
              −
            </button>
            <button
              className={showAll ? "btn round toggle-on" : "btn round"}
              onClick={() => setShowAll((s) => !s)}
              aria-pressed={showAll}
              aria-label={showAll ? "Back to zoom-filtered events" : "View all events"}
              title={
                showAll
                  ? "Back to the events this zoom level shows"
                  : "Temporarily show every event at this zoom level"
              }
            >
              <EyeIcon />
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

      {searchOpen && (
        <SearchModal
          events={events}
          onPick={goToEvent}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
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
  placed,
  view,
  width,
  height,
  vertical,
  colWidth,
  onSelect,
}: {
  placed: PlacedEvent[];
  view: ViewState;
  width: number;
  height: number;
  vertical: boolean;
  colWidth: number;
  onSelect: (id: string) => void;
}) {
  // `mainSpan` runs along the time axis; `axisPos` is the axis's offset across
  // it — how far down the surface (horizontal) or how far in from the left
  // (vertical). Cards sit on the far side of the axis from the year labels.
  const mainSpan = vertical ? height : width;
  const axisPos = vertical ? V_AXIS_X : height * AXIS_FRAC;
  const ticks = computeTicks(mainSpan, view);

  const present = new Date().getFullYear();
  const presentPos = posOfYear(present, view);
  const showPresent = presentPos >= 0 && presentPos <= mainSpan;
  const spanLabel = describeSpan(visibleSpanYears(mainSpan, view));

  return (
    <>
      {/* faint gridlines aligned with year ticks */}
      {ticks.map((t) => (
        <div
          key={`g${t.year}`}
          className="gridline"
          style={
            vertical
              ? { top: t.pos, left: axisPos, width: Math.max(0, width - axisPos), height: 1 }
              : { left: t.pos, top: 0, width: 1, height: axisPos }
          }
        />
      ))}

      {/* the axis line */}
      <div
        className={vertical ? "axis v" : "axis"}
        style={
          vertical
            ? { left: axisPos, top: 0, width: 2, height }
            : { left: 0, top: axisPos, width, height: 2 }
        }
      />

      {/* present-day marker */}
      {showPresent && (
        <div
          className={vertical ? "present v" : "present"}
          style={
            vertical
              ? { top: presentPos, left: 0, width, height: 2 }
              : { left: presentPos, top: 0, width: 2, height }
          }
        >
          <span className="present-label">now</span>
        </div>
      )}

      {/* year tick marks + labels on the label side of the axis */}
      {ticks.map((t) => (
        <div key={`t${t.year}`}>
          <div
            className={`tick${t.major ? " major" : ""}${vertical ? " v" : ""}`}
            style={
              vertical
                ? { top: t.pos, left: axisPos - (t.major ? 18 : 10) }
                : { left: t.pos, top: axisPos }
            }
          />
          <div
            className={`tick-label${t.major ? " major" : ""}${vertical ? " v" : ""}`}
            style={
              vertical
                ? { top: t.pos, left: 0, width: Math.max(0, axisPos - 14) }
                : { left: t.pos, top: axisPos + 12 }
            }
          >
            {formatYearShort(t.year)}
          </div>
        </div>
      ))}

      {/* events on the card side of the axis */}
      {placed.map((p) => {
        const color = LEVEL_COLOR[p.event.level];
        // Where this lane's cards start, measured across the axis.
        const laneEdge = vertical
          ? axisPos + AXIS_GAP + p.lane * (colWidth + V_COL_GAP)
          : axisPos - AXIS_GAP - p.lane * LANE_H;
        return (
          <div
            key={p.event.id}
            data-event-id={p.event.id}
            onClick={() => onSelect(p.event.id)}
          >
            <div
              className={vertical ? "event-stem v" : "event-stem"}
              style={{
                ...(vertical
                  ? { left: axisPos, top: p.pos, width: laneEdge - axisPos, height: 2 }
                  : { left: p.pos, top: laneEdge, width: 2, height: axisPos - laneEdge }),
                background: color,
              }}
            />
            <div
              className="event-dot"
              style={{
                left: vertical ? axisPos : p.pos,
                top: vertical ? p.pos : axisPos,
                background: color,
                boxShadow: `0 0 8px ${color}cc`,
              }}
            />
            <div
              className="event-card"
              style={{
                left: vertical ? laneEdge : p.pos - p.width / 2,
                top: vertical ? p.pos - CARD_H / 2 : laneEdge - CARD_H - 2,
                width: p.width,
                height: CARD_H,
                borderColor: `${color}66`,
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

      {/* clear of the year labels, which run down the left gutter vertically */}
      <div className={vertical ? "span-label v" : "span-label"}>{spanLabel}</div>
    </>
  );
}

/** Magnifier for the search button — a glyph like ⌕ is too small and varies
 * too much between platforms to sit next to the other icons. */
function SearchIcon() {
  return (
    <svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="M15.4 15.4 20.5 20.5" />
      </g>
    </svg>
  );
}

/** The "view all" toggle's glyph — an open eye, drawn to match the text icons. */
function EyeIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M1.8 12S5.9 5.5 12 5.5 22.2 12 22.2 12 18.1 18.5 12 18.5 1.8 12 1.8 12Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3.1" fill="currentColor" />
    </svg>
  );
}

function SearchModal({
  events,
  onPick,
  onClose,
}: {
  events: TimelineEvent[];
  onPick: (e: TimelineEvent) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  // An empty query lists everything, so the search box doubles as an index of
  // the timeline in date order.
  const results = events
    .filter((e) => matchesQuery(e, query))
    .sort((a, b) => a.year - b.year);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Search</h2>

        <label className="field">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Title or description…"
          />
        </label>

        <div className="results">
          {results.length === 0 ? (
            <div className="results-empty">
              {events.length === 0 ? "No events yet." : `Nothing matches “${query.trim()}”.`}
            </div>
          ) : (
            results.map((e) => (
              <button key={e.id} className="result" onClick={() => onPick(e)}>
                <span
                  className="result-dot"
                  style={{ background: LEVEL_COLOR[e.level] }}
                />
                <span className="result-title">{e.title || "(untitled)"}</span>
                <span className="result-year">{formatYear(e.year)}</span>
              </button>
            ))
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function describeSpan(years: number): string {
  const y = Math.round(years);
  if (y >= 2000) return `Viewing ~${(y / 1000).toFixed(1)}k years`;
  return `Viewing ~${y} years`;
}

/** Word for where a 1-10 dial currently sits. */
function dialLabel(value: number, words: [string, string, string]): string {
  return value <= 3 ? words[0] : value <= 7 ? words[1] : words[2];
}

function SettingsModal({
  settings,
  onChange,
  onClose,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}) {
  const options: { value: Orientation; label: string; hint: string }[] = [
    { value: "auto", label: "Auto", hint: "Follow how the phone is held" },
    { value: "horizontal", label: "Horizontal", hint: "Time runs left → right" },
    { value: "vertical", label: "Vertical", hint: "Time runs top → bottom" },
  ];
  const { inertiaEnabled } = settings;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <div className="field">
          <span>Timeline direction</span>
          <div className="choice-row">
            {options.map((o) => (
              <button
                key={o.value}
                className={
                  settings.orientation === o.value ? "choice selected" : "choice"
                }
                onClick={() => onChange({ orientation: o.value })}
                aria-pressed={settings.orientation === o.value}
              >
                <span className="choice-label">{o.label}</span>
                <span className="choice-hint">{o.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Scrolling</span>
          <label className="field-check">
            <input
              type="checkbox"
              checked={inertiaEnabled}
              onChange={(e) => onChange({ inertiaEnabled: e.target.checked })}
            />
            Keep coasting after a flick
          </label>

          <Dial
            label="How far it glides"
            value={settings.inertiaGlide}
            reading={dialLabel(settings.inertiaGlide, ["Short", "Medium", "Long"])}
            ends={["Short", "Long"]}
            disabled={!inertiaEnabled}
            onChange={(inertiaGlide) => onChange({ inertiaGlide })}
          />
          <Dial
            label="Flick needed to set it off"
            value={settings.inertiaForce}
            reading={dialLabel(settings.inertiaForce, ["Light", "Medium", "Firm"])}
            ends={["Light", "Firm"]}
            disabled={!inertiaEnabled}
            onChange={(inertiaForce) => onChange({ inertiaForce })}
          />
        </div>

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function Dial({
  label,
  value,
  reading,
  ends,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  reading: string;
  ends: [string, string];
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className={disabled ? "dial disabled" : "dial"}>
      <div className="dial-head">
        <span className="dial-label">{label}</span>
        <span className="dial-reading">{reading}</span>
      </div>
      <input
        className="slider"
        type="range"
        min={1}
        max={10}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="dial-ends">
        <span>{ends[0]}</span>
        <span>{ends[1]}</span>
      </div>
    </div>
  );
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
