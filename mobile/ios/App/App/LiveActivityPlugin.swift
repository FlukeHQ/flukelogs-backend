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
