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

- `src/App.tsx` — the whole UI: the pan/zoom surface, event cards, Add/Edit and
  detail modals, full-screen mode, and the sync effects (pull on launch,
  debounced push on edit).
- `src/timeline.ts` — pure helpers: coordinate transforms, zoom clamp, the
  importance-level model, tick steps, event lane layout, date/month parsing.
- `src/storage.ts` — localStorage load/save (events, view, updatedAt) + old-data
  migration.
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
- **Pan/zoom** is custom pointer handling (no library); a `dragged` ref
  distinguishes a tap (opens details) from a drag/pinch.
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
