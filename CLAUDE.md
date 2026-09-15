# CLAUDE.md

Guidance for working in this repo.

## What this is

A personal Android app to visualize a world-history timeline. Web app (Vite +
React + TypeScript) wrapped with **Capacitor** into an APK. Single user, no
login. Data is local-first (`localStorage`) and optionally synced to Supabase so
a reinstall restores it. Published via GitHub Releases:
`github.com/hallucinogenizer/world-history-timeline`.

## Commands

```bash
npm run dev                 # local dev server (hot reload) — fastest for QA
npm run build               # typecheck (tsc -b) + vite build → dist/
npm run preview             # serve the built dist/ (http://localhost:4173)
```

Build the APK (needs the Android SDK + JDK 21; the machine's default JDK is too
new, so use Android Studio's bundled JBR):

```bash
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
npm run build
npx cap sync android
(cd android && ./gradlew assembleDebug)
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Regenerate app icons after changing `assets/icon-*.png`:

```bash
npx @capacitor/assets generate --android
```

Publish a release (uploads the APK):

```bash
gh release create vX.Y.Z "apk-share/WorldHistoryTimeline.apk#World History Timeline (Android APK)" \
  --title "..." --notes-file <notes.md>
```

## Layout

- `src/App.tsx` — the whole UI: the pan/zoom surface, event cards, Add/Edit,
  detail and settings modals, full-screen mode, and the sync effects (pull on
  launch, debounced push on edit).
- `src/timeline.ts` — pure helpers: coordinate transforms, zoom clamp, the
  importance-level model, tick steps, event lane layout, date/month parsing.
- `src/storage.ts` — localStorage load/save (events, view, updatedAt, settings)
  + old-data migration.
- `src/sync.ts` — Supabase sync client (calls the Edge Function).
- `src/types.ts` — `TimelineEvent`, `ViewState`.
- `supabase/functions/timeline/` — the sync Edge Function (`@supabase/server`).
- `supabase/schema.sql` — the locked `private_timeline` table.

## Key design points

- **Importance levels (L1–L6).** An event's level is *how long it stayed
  significant*: L1 = 1000 yr … L6 = 1 yr (`LEVEL_YEARS` in `timeline.ts`). A
  level is visible once its cadence occupies at least `LEVEL_VISIBLE_PX` (96px)
  on screen (`levelVisible` = `span * pxPerYear >= 96`). This is **decoupled**
  from the axis tick step: the tick ladder (`NICE_STEPS`, target
  `TICK_TARGET_PX`) is denser so year labels appear as soon as there's room,
  while level visibility stays on its own threshold so denser labels don't pull
  minor events in early. Zooming out drops the finer levels.
- **View clamp.** `clampView` stops horizontal scroll from going far past the
  present (right edge ≤ present + ~15% of the visible span, capped) or before
  `PAST_LIMIT_YEAR`. Every view mutation in `App.tsx` goes through `clamp(...)`.
- **Orientation.** Settings (gear in the top bar) switches between auto,
  horizontal (time left → right) and vertical (time top → bottom); auto picks
  vertical whenever the surface is taller than it is wide, so rotating the
  phone flips it. Settings also holds the scroll-inertia dials. The choices are
  local-only
  (`timeline.settings.v1`), not part of the synced snapshot. Internally there's
  one time axis: `posOfYear` / `yearAtPos` / `clampView` all work in "pixels
  along the axis" (`mainSpan` = width horizontally, height vertically), and
  pointer input is converted to `main`/`cross` so one set of gesture maths
  serves both. Vertically the axis sits at `V_AXIS_X`, year labels in the gutter
  to its left and event cards in columns to its right.
- **Lane layout.** Horizontally (`layoutEvents`) each importance level gets its
  own band of lanes, most important highest. Vertically
  (`layoutEventsVertical`) a phone only fits one column, so levels *share*
  columns — cards are placed most-important-first and only crowding pushes one
  outward. Either way, when the lanes run out the least-important cards are
  dropped rather than overlapped, and the count comes back as `overflow` for the
  badge to report.
- **View all.** The eye toggle in the zoom controls temporarily ignores the
  zoom-level filter and shows every event. Deliberately not persisted — it's a
  peek.
- **Search** (magnifier in the top bar) filters on title + description; an empty
  query lists every event by date, so it doubles as an index. Picking a result
  calls `viewFocusedOn` — centre on the event and zoom in just far enough that
  its level is visible, never zooming out — then opens its detail card.
- **Top bar** holds only the frequent actions (search, full screen); Add event
  and Settings live behind the `⋮` menu.
- **Pan/zoom** is custom pointer handling (no library); a `dragged` ref
  distinguishes a tap (opens details) from a drag/pinch. A flick coasts: pointer
  moves feed a smoothed velocity (px/ms along the time axis), and on release a
  rAF loop pans with exponential decay until it's slow enough to stop or the
  view clamp stalls it. Settings exposes the glide as two 1-10 dials plus an
  on/off — `flingTau` (decay time constant: how far it carries) and
  `flingMinVelocity` (the release speed that counts as a flick) in `App.tsx`
  map them onto the numbers the loop runs on, both tuned so 5 reproduces the
  original feel. Anything that moves the view
  (touch, wheel, zoom buttons, Now, a search jump) cancels the glide first, and
  the tap that catches a moving timeline only stops it — it doesn't open a card.
- **Sync/security.** The app authenticates to the Edge Function with the
  **publishable** key and a secret timeline UUID (both in `.env`, baked at build
  time). The **secret** key is server-side only — never in the bundle or git.
  The table has RLS on with no policies; only the function's admin client
  reaches it. See `memory/timeline-supabase-sync.md` in the user's Claude memory
  for redeploy details. Config lives in `.env` (gitignored); see `.env.example`.

## Conventions & gotchas

- Keep secrets out of the repo. `.env`, `supabase/.temp/` are gitignored. After
  changing the web app, `npm run build` **then** `npx cap sync android` before
  building the APK, or the APK ships stale assets.
- After any nontrivial change, verify in a browser (`npm run preview` +
  drive it) — the timeline is interaction-heavy.
- Some actions are blocked by the Claude Code auto-mode classifier and must be
  run by the user with `!`: reading the macOS keychain, `supabase db query`,
  destructive SQL via the Management API, and sometimes `gh release create`.
- `Date.now()` / `new Date()` are fine in the app (browser), but not in
  Workflow scripts.
