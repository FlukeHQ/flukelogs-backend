# Trip Logger — iOS app (Capacitor wrapper)

This directory is the native iOS app. It is intentionally isolated from
`../trip-logger/` so the Vercel deploy of the web PWA is never affected by
mobile work.

## What Phase 1 does

The native shell launches and loads the live PWA at
`https://trip-logger-backend.vercel.app/` via Capacitor's `server.url`. No
code in `trip-logger/` changed; behaviour on iOS matches the PWA exactly.
This includes the existing foreground-only GPS — Phase 2 will replace that
with a native background-location plugin while keeping the web fallback.

## What you need on your Mac (one-time)

1. Xcode 15 or newer, installed from the Mac App Store.
2. Xcode Command Line Tools: `xcode-select --install`.
3. CocoaPods: `sudo gem install cocoapods` (or via Homebrew).
4. Node 20.x (matches `../trip-logger/package.json` engine).
5. An Apple Developer account, with a Team you can sign with.

## First-time setup

Run from this directory (`mobile/`):

```bash
npm install
npx cap add ios
npx cap sync ios
```

`cap add ios` scaffolds the Xcode project under `ios/App/`. After it runs,
commit the generated `ios/` folder (the `.gitignore` here already excludes
the parts that should not be in version control: Pods, build output,
DerivedData, the regenerated `ios/App/App/public/` mirror of `www/`).

Then open Xcode:

```bash
npx cap open ios
```

## Before every build and every archive: sync the config

```bash
npx cap copy ios
```

`ios/App/App/capacitor.config.json` is a generated copy of the one in this
directory, and `.gitignore` excludes it, so a fresh clone or a stale
checkout can carry an old version. The runtime reads only the generated
copy.

This matters most for `packageClassList`. It is the list of native plugin
classes Capacitor exposes to JS, and a plugin missing from the generated
copy is simply absent from `window.Capacitor.Plugins` at runtime. The web
layer's null guards then make it a silent no-op: no crash, no console
error, the feature just never happens. That is exactly how the 1.1 Live
Activity was invisible on the lock screen while the plugin was compiled,
linked, and correct.

## Running on a device

1. Plug your iPhone in and trust the Mac when prompted.
2. In Xcode, top bar: select your device as the run target.
3. Project navigator → `App` → `Signing & Capabilities`. Select your
   Apple Developer Team. Xcode will register the bundle id
   `com.flukesend.flukelogs` (or your chosen id, see below) with your
   account automatically the first time.
4. Press the Run (▶) button. The app installs and launches; you should
   see the Trip Logger PWA exactly as it appears in mobile Safari.

If you've never run a dev app on this iPhone before, iOS may show
"Untrusted Developer" the first time. Open Settings → General → VPN &
Device Management → trust your developer profile, then re-launch.

## Bundle id and app name

Defaults in `capacitor.config.json`:

- `appId`: `com.flukesend.flukelogs`
- `appName`: `Trip Logger`

You can change either before running `cap add ios`. The bundle id is hard
to change after submission, so pick the one you want now. Reverse-DNS of
a domain you own is the convention. Keeping `appName` generic ("Trip
Logger") matches the multi-tenant intent; if you want "Enocean Tours" on
the App Store listing instead, change `appName` and you can set a
separate marketing name in App Store Connect later.

## What is NOT in this Phase 1

- Native background GPS (Phase 2).
- Offline operation (the app needs a network connection to load the PWA
  on launch in this phase; Phase 2 swaps to a local bundle).
- Info.plist usage strings, app icons, splash screen, Universal Links,
  push (Phase 4).

## Reverting

To remove the mobile setup entirely: delete this `mobile/` directory.
Nothing outside it changes anything in `trip-logger/`.
