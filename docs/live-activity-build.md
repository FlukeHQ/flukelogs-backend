# Live Activity (v1.1): lock screen trip card + dive timer

What ships: while a trip runs, the lock screen and Dynamic Island show a card
with the trip clock (self ticking), the current position in plotter format
with distance, and a whale dive timer. Start dive / Surfaced / a red X to
abandon a timing, all as buttons on the locked phone (iOS 17+; older phones
see the card, buttons need the app). After one completed dive the card
predicts the next surfacing from the recent rhythm and a Time Sensitive
local notification chimes 10 seconds before it: "Likely surfacing, cameras
ready." Surfaced feeds the average; the X never does; a 15 minute surface
gap resets the rhythm (new whale). Long divers are normal: no ceiling on the
timer, and past the prediction the card flips to "she's gone long."

All code is on this branch. One thing cannot be done from the command line
safely: creating the widget extension target. That is a two minute Xcode GUI
step, below.

## One time Xcode setup (do once, ~5 minutes)

Open `~/trip-logger-backend/mobile/ios/App/App.xcworkspace` (not the
xcodeproj, and not the stale clone in ~/Documents).

1. **Create the extension target.** File > New > Target > Widget Extension.
   - Product Name: exactly `FlukelogsActivity`
   - UNCHECK "Include Configuration App Intent" if offered
   - CHECK "Include Live Activity" if offered (either way is fine, we replace
     the files)
   - Team: SLATER THOMAS MOORE. Finish. If Xcode asks to activate the new
     scheme, either answer is fine.
2. **Replace the generated files.** In the new FlukelogsActivity group Xcode
   made, delete every generated .swift file (Move to Trash). Then right click
   the group > Add Files, and add the four files already sitting in
   `mobile/ios/App/FlukelogsActivity/`:
   - `TripActivityAttributes.swift`
   - `DiveTimerStore.swift`
   - `DiveIntents.swift`
   - `FlukelogsActivityWidget.swift`
3. **Fix target membership** (File Inspector, right panel, tick boxes):
   - `TripActivityAttributes.swift`, `DiveTimerStore.swift`,
     `DiveIntents.swift`: **both** App and FlukelogsActivity
   - `FlukelogsActivityWidget.swift`: FlukelogsActivity only
   - `LiveActivityPlugin.swift` + `.m` (in the App group): App only; Xcode
     will have added them when the project reloaded, verify they are there
4. **App Group on both targets.** Signing & Capabilities > + Capability >
   App Groups, on the App target AND the FlukelogsActivity target, same
   group on each: `group.com.flukesend.flukelogs` (automatic signing
   registers it). This is how the lock screen buttons and the app share the
   dive state; without it on both, buttons tap but nothing moves.
5. **Deployment target of the extension**: set FlukelogsActivity to iOS 16.2
   (General tab). The main app stays at 13.0.
6. Build once (Cmd+B) on Any iOS Device. Expected: compiles clean. If the
   extension complains about missing types, a membership box in step 3 was
   missed.

Already done on this branch, no action: `NSSupportsLiveActivities` in the
App Info.plist, plugin registration in capacitor.config.json (run
`npx cap sync ios` from `mobile/` if the build cannot find the plugin), and
the web layer wiring (guarded no-ops everywhere the plugin is absent).

## Device test script (the only test that counts)

1. Archive to the phone (or Run straight onto it via cable).
2. Start a trip. Lock the phone. The card should appear with the trip clock
   ticking and, within a minute, the position line.
3. Tap Start dive on the lock screen. Clock runs. First dive shows "timing
   the rhythm."
4. Tap Surfaced after ~30s. Card shows "last dive 0:30."
5. Start dive again: card now says "expect surfacing ~0:30 · chime armed."
   Let it run: chime should fire ~10s before 0:30 (ringer on), and a minute
   past it the line flips to "she's gone long."
6. The X: start a dive, tap X, confirm "last dive" is unchanged (an
   abandoned timing taught nothing).
7. End Trip in the app: card leaves the lock screen immediately.
8. Real trip: confirm the card and buttons behave after hours locked, which
   no simulator proves.

## Notes for future work

- Quick species logging from the card was designed and deliberately parked
  (founder call, 2026-08-02): buttons-only flow, top 3 species then count
  steppers. Revisit after the dive timer proves itself.
- Dive durations currently live on the card only. Persisting them per trip
  (avg dive time as a widget stat) is a schema question for later.
- The chime is the system default sound for now; a custom sonar chime is a
  30s .caf in the extension bundle when someone wants to pick one.
