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

/*
  1.3: notification actions, the locked-phone front door.

  iOS will not run a Live Activity button without unlock (see DiveIntents'
  history), but it WILL run a notification action posted by the app, provided
  the action does not set .authenticationRequired. So the plugin registers
  two categories at load and owns the notification center delegate:

  - FL_CHIME: the surfacing chime gains a Surfaced button, which records the
    dive right from the locked screen.
  - FL_STILL_LOGGING: the harbor fence prompt, with Still out and End trip.
    The plugin only reports which button was tapped; the DECISION stays in
    the web layer, so policy (like auto-end) can change over the wire with no
    new binary and no review round.

  The delegate also shows banners while the app is foregrounded, since a
  fence prompt with the phone in hand is still worth seeing.
*/
extension LiveActivityPlugin: UNUserNotificationCenterDelegate {

    static let chimeCategory = "FL_CHIME"
    static let fenceCategory = "FL_STILL_LOGGING"
    private static let fenceNoteId = "flukelogs-still-logging"

    func registerNotificationCategories() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let surfaced = UNNotificationAction(identifier: "SURFACED", title: "Surfaced", options: [])
        let chime = UNNotificationCategory(
            identifier: Self.chimeCategory, actions: [surfaced], intentIdentifiers: [], options: [])
        let stillOut = UNNotificationAction(identifier: "STILL_OUT", title: "Still out watching", options: [])
        let endTrip = UNNotificationAction(identifier: "END_TRIP", title: "End the trip", options: [.destructive])
        let fence = UNNotificationCategory(
            identifier: Self.fenceCategory, actions: [stillOut, endTrip], intentIdentifiers: [], options: [])
        center.setNotificationCategories([chime, fence])
    }

    @objc func promptStillLogging(_ call: CAPPluginCall) {
        let content = UNMutableNotificationContent()
        content.title = call.getString("title") ?? "Back at the dock?"
        content.body = call.getString("body") ?? "Looks like the boat is in. Still logging whales?"
        content.sound = .default
        content.categoryIdentifier = Self.fenceCategory
        if #available(iOS 15.0, *) { content.interruptionLevel = .timeSensitive }
        let request = UNNotificationRequest(identifier: Self.fenceNoteId, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { err in
            call.resolve(["posted": err == nil])
        }
    }

    @objc func clearStillLogging(_ call: CAPPluginCall) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [Self.fenceNoteId])
        center.removeDeliveredNotifications(withIdentifiers: [Self.fenceNoteId])
        call.resolve()
    }

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        NSLog("[Flukelogs] notification action: %@", response.actionIdentifier)
        // A plain tap (the default action) opens the app; for the fence
        // prompt that must ASK the question in-app, because most crew tap
        // rather than long-press. The long-press buttons stay as the fast
        // path for whoever knows them. Slater's call after the first field
        // test of the buttons.
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            if response.notification.request.content.categoryIdentifier == Self.fenceCategory {
                notifyListeners("fencePrompt", data: ["answer": "opened"], retainUntilConsumed: true)
            }
            completionHandler()
            return
        }
        switch response.actionIdentifier {
        case "SURFACED":
            _ = DiveTimerStore.surfaced()
            if #available(iOS 16.2, *) {
                Task {
                    for activity in Activity<TripActivityAttributes>.activities {
                        var state = activity.content.state
                        DiveTimerStore.pushDiveState(into: &state)
                        await activity.update(ActivityContent(state: state, staleDate: nil))
                    }
                    completionHandler()
                }
                return
            }
        case "STILL_OUT":
            notifyListeners("fencePrompt", data: ["answer": "still_out"], retainUntilConsumed: true)
        case "END_TRIP":
            notifyListeners("fencePrompt", data: ["answer": "end_trip"], retainUntilConsumed: true)
        default:
            break
        }
        completionHandler()
    }

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
