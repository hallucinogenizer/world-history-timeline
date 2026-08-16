# World History Timeline

A personal Android app for visualizing a world-history timeline. No login, no
network — all events are stored locally on the device.

- **Stack:** Vite + React + TypeScript web app wrapped in [Capacitor](https://capacitorjs.com) → native Android APK.
- **Storage:** browser `localStorage` inside the app's WebView (per-device, offline).

## Features

- Empty by default. Horizontal timeline: past on the left, present on the right.
- Years shown below the axis, event cards above it. Works in portrait & landscape.
- **Add Event** — title, description, year (required), optional month/day, and a "star".
- Tap an event to see its exact date (month/day if provided).
- Pan left/right (drag) and zoom in/out (pinch, mouse wheel, or the +/− buttons).
- Zoom out far enough and only **starred** events remain visible.

## Prerequisites (already set up on this machine)

- Node.js + npm
- Android SDK command-line tools at `/opt/homebrew/share/android-commandlinetools`
  (installed via `brew install --cask android-commandlinetools`)
- A JDK 21 — we use Android Studio's bundled runtime:
  `/Applications/Android Studio.app/Contents/jbr/Contents/Home`
  (the system's JDK 26 is too new for Android's Gradle.)

## Rebuild the APK after changing the app

```bash
cd ~/dev/timeline

# 1. Build the web app
npm run build

# 2. Point Gradle at the SDK + JDK 21 and build the APK
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
npx cap sync android
cd android && ./gradlew assembleDebug
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`.

## Develop in a browser (fast iteration)

```bash
npm run dev      # http://localhost:5173
```

## Install on the phone

See the two methods below (Wi-Fi download or `adb install`).
