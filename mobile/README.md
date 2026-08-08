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

## How native plugins get registered (read before adding one)

Capacitor on iOS registers plugins **only** from the `packageClassList`
array inside the `capacitor.config.json` in the built bundle. There is no
Objective-C runtime scan; see `registerPlugins()` in Capacitor's
`CapacitorBridge.swift`. A plugin that is not in that list is simply absent
from `window.Capacitor.Plugins`, and because the web layer null-guards every
plugin call, the result is a silent no-op: no crash, no console error, the
feature just never happens.

`ios/App/App/capacitor.config.json` is **generated** by `npx cap copy ios`
and gitignored. `cap copy` rebuilds `packageClassList` from the
npm-installed Capacitor packages, so it cannot know about a plugin that is a
plain class in the App target, and it strips any hand-added entry every time
it runs.

**So app-local plugins are registered in code instead**, in
`App/MainViewController.swift`:

```swift
override func capacitorDidLoad() {
    super.capacitorDidLoad()
    bridge?.registerPluginInstance(LiveActivityPlugin())
}
```

That path does not depend on the generated file, so `cap copy` is safe to
run whenever you like. Add any future app-local plugin the same way, and
keep the `NSLog` line below it: registration fails silently if a plugin
stops conforming to `CAPBridgedPlugin`, and the log line turns that into
something you can see.

Plugins installed as npm packages (the background-geolocation one) still
come through `packageClassList` automatically and need nothing.

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
