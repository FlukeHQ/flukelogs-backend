//
//  LiveActivityPlugin.swift
//  App target only. The bridge the web layer drives: start the trip card at
//  Start Trip, refresh the position line as GPS batches land, end it at End
//  Trip or discard. The dive buttons never come through here; they are App
//  Intents that run on the lock screen (see FlukelogsActivity/DiveIntents).
//
//  Every method is a safe no-op below iOS 16.2 or when Live Activities are
//  switched off, so the web layer can call unconditionally.
//

import ActivityKit
import Capacitor
import Foundation
import UserNotifications

@objc(LiveActivityPlugin)
public class LiveActivityPlugin: CAPPlugin {

    /*
      The repaint half of the lock screen dive buttons.

      The buttons are plain AppIntents running in the widget extension, which
      is the only way they work on a locked passcode phone (see
      DiveIntents.swift). The extension cannot push ActivityKit updates, so a
      tap changes DiveTimerStore and nothing else; the card would sit stale
      until the next GPS-driven update, up to thirty seconds away, which on
      the rail reads as a dead button.

      So while a trip activity exists, the app watches the store. During a
      trip the app is alive in the background anyway for GPS, and the watcher
      is a three second timer comparing one UserDefaults value; on change it
      pushes the activity update the extension could not. Tap to repaint is
      then at most three seconds, usually about one.
    */
    private var diveWatcher: Timer?
    private var lastPushedDiveStart: Date?

    private func startDiveWatcher() {
        guard #available(iOS 16.2, *) else { return }
        stopDiveWatcher()
        lastPushedDiveStart = nil
        let t = Timer(timeInterval: 3, repeats: true) { [weak self] _ in
            self?.pushDiveStateIfChanged()
        }
        t.tolerance = 1
        RunLoop.main.add(t, forMode: .common)
        diveWatcher = t
    }

    private func stopDiveWatcher() {
        diveWatcher?.invalidate()
        diveWatcher = nil
    }

    private func pushDiveStateIfChanged() {
        guard #available(iOS 16.2, *) else { return }
        let current = UserDefaults(suiteName: DiveTimerStore.appGroup)?
            .object(forKey: "dive_started_at") as? Date
        guard current != lastPushedDiveStart else { return }
        lastPushedDiveStart = current
        Task {
            for activity in Activity<TripActivityAttributes>.activities {
                var state = activity.content.state
                DiveTimerStore.pushDiveState(into: &state)
                await activity.update(ActivityContent(state: state, staleDate: nil))
            }
        }
    }

    @objc func startTrip(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *), ActivityAuthorizationInfo().areActivitiesEnabled else {
            call.resolve(["started": false])
            return
        }
        // The surfacing chime needs notification permission; asking at Start
        // Trip means the prompt appears dockside, not mid encounter.
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }

        let startedMs = call.getDouble("startedAt") ?? Date().timeIntervalSince1970 * 1000
        let boatName = call.getString("boatName") ?? "On the water"

        DiveTimerStore.clearTrip()
        endAllActivities() // never two cards for one boat

        let attributes = TripActivityAttributes(
            tripStartedAt: Date(timeIntervalSince1970: startedMs / 1000),
            boatName: boatName
        )
        var state = TripActivityAttributes.ContentState(
            positionText: "",
            distanceNm: 0,
            diveStartedAt: nil,
            expectedSurfacing: nil,
            lastDiveSeconds: nil
        )
        DiveTimerStore.pushDiveState(into: &state)
        do {
            _ = try Activity.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: nil)
            )
            call.resolve(["started": true])
            startDiveWatcher()
        } catch {
            call.resolve(["started": false, "error": error.localizedDescription])
        }
    }

    @objc func updateTrip(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { return call.resolve() }
        let positionText = call.getString("positionText") ?? ""
        let distanceNm = call.getDouble("distanceNm") ?? 0
        Task {
            for activity in Activity<TripActivityAttributes>.activities {
                var state = activity.content.state
                state.positionText = positionText
                state.distanceNm = distanceNm
                // Keep the dive row truthful even if an intent ran since the
                // last web update.
                DiveTimerStore.pushDiveState(into: &state)
                await activity.update(ActivityContent(state: state, staleDate: nil))
            }
            call.resolve()
        }
    }

    @objc func endTrip(_ call: CAPPluginCall) {
        stopDiveWatcher()
        guard #available(iOS 16.2, *) else { return call.resolve() }
        DiveTimerStore.clearTrip()
        Task {
            await endAllActivitiesAsync()
            call.resolve()
        }
    }

    private func endAllActivities() {
        guard #available(iOS 16.2, *) else { return }
        Task { await endAllActivitiesAsync() }
    }

    @available(iOS 16.2, *)
    private func endAllActivitiesAsync() async {
        for activity in Activity<TripActivityAttributes>.activities {
            await activity.end(activity.content, dismissalPolicy: .immediate)
        }
    }
}
