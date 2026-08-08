//
//  DiveTimerStore.swift
//  Membership: BOTH targets. The dive state and the surfacing chime live
//  here so the lock screen buttons (App Intents, running without the app
//  being opened) and the app agree on one source of truth.
//
//  Storage is the app group's UserDefaults. The chime is a scheduled local
//  notification: computed and queued the moment a dive starts, so it fires
//  on time with zero signal, and cancelled the moment the whale surfaces or
//  the timing is abandoned.
//

import ActivityKit
import Foundation
import UserNotifications

enum DiveTimerStore {
    // Must match the App Group added to BOTH targets in Signing & Capabilities.
    static let appGroup = "group.com.flukesend.flukelogs"

    private static let historyKey = "dive_history_seconds"
    private static let diveStartKey = "dive_started_at"
    private static let chimeId = "flukelogs-surfacing-chime"

    // A surface interval this long means we are on a different animal now;
    // the learned rhythm no longer applies and the history clears itself.
    private static let encounterResetSeconds: TimeInterval = 15 * 60
    private static let lastSurfacedKey = "last_surfaced_at"

    // Chime this far ahead of the predicted surfacing.
    private static let chimeLeadSeconds: TimeInterval = 10

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }

    // MARK: - Dive lifecycle

    static func startDive(at now: Date = Date()) -> (expected: Date?, started: Date) {
        // A long gap since the last surfacing means a new encounter.
        if let last = defaults.object(forKey: lastSurfacedKey) as? Date,
           now.timeIntervalSince(last) > encounterResetSeconds {
            defaults.removeObject(forKey: historyKey)
        }
        defaults.set(now, forKey: diveStartKey)
        let expected = predictedSurfacing(from: now)
        if let expected {
            scheduleChime(at: expected.addingTimeInterval(-chimeLeadSeconds))
        }
        return (expected, now)
    }

    static func surfaced(at now: Date = Date()) -> Int? {
        cancelChime()
        guard let started = defaults.object(forKey: diveStartKey) as? Date else { return nil }
        defaults.removeObject(forKey: diveStartKey)
        defaults.set(now, forKey: lastSurfacedKey)
        let seconds = Int(now.timeIntervalSince(started))
        guard seconds > 0 else { return nil }
        var history = defaults.array(forKey: historyKey) as? [Int] ?? []
        history.append(seconds)
        // The rhythm is the recent rhythm: the last three dives.
        if history.count > 3 { history.removeFirst(history.count - 3) }
        defaults.set(history, forKey: historyKey)
        return seconds
    }

    // The red X: stop timing, record nothing, disarm the chime. A dive that
    // was abandoned must never teach the average anything.
    static func cancelDive() {
        cancelChime()
        defaults.removeObject(forKey: diveStartKey)
    }

    static func clearTrip() {
        cancelChime()
        defaults.removeObject(forKey: diveStartKey)
        defaults.removeObject(forKey: historyKey)
        defaults.removeObject(forKey: lastSurfacedKey)
    }

    static func lastDiveSeconds() -> Int? {
        (defaults.array(forKey: historyKey) as? [Int])?.last
    }

    // MARK: - Prediction

    private static func predictedSurfacing(from start: Date) -> Date? {
        guard let history = defaults.array(forKey: historyKey) as? [Int], !history.isEmpty else {
            return nil
        }
        let avg = history.reduce(0, +) / history.count
        return start.addingTimeInterval(TimeInterval(avg))
    }

    // MARK: - Chime

    private static func scheduleChime(at fireDate: Date) {
        let interval = fireDate.timeIntervalSinceNow
        guard interval > 1 else { return }
        let content = UNMutableNotificationContent()
        content.title = "Likely surfacing"
        content.body = "Cameras ready. This whale has been coming up about now."
        content.sound = .default
        // Breaks through Focus and lights the screen on a locked phone at the
        // rail. On silent it still vibrates and lights.
        //
        // Guarded because this file is compiled into BOTH targets: the
        // extension is iOS 16.2, but the app still supports iOS 13, and
        // interruptionLevel arrived in 15. On anything older the chime still
        // fires, it just does not break through Focus.
        if #available(iOS 15.0, *) {
            content.interruptionLevel = .timeSensitive
        }
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
        let request = UNNotificationRequest(identifier: chimeId, content: content, trigger: trigger)
        UNUserNotificationCenter.current().add(request)
    }

    private static func cancelChime() {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [chimeId])
    }

    // MARK: - Activity update shared by the intents and the plugin

    @available(iOS 16.2, *)
    static func pushDiveState(into state: inout TripActivityAttributes.ContentState) {
        state.diveStartedAt = defaults.object(forKey: diveStartKey) as? Date
        if let started = state.diveStartedAt {
            state.expectedSurfacing = predictedSurfacing(from: started)
        } else {
            state.expectedSurfacing = nil
        }
        state.lastDiveSeconds = lastDiveSeconds()
    }
}
