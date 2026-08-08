//
//  DiveIntents.swift
//  Membership: BOTH targets (intents that appear on a Live Activity must be
//  visible to the app that owns the activity).
//
//  The lock screen buttons. Each intent flips the dive state in
//  DiveTimerStore, then repaints every running trip activity so the card
//  reflects it immediately. No unlock, no app launch.
//

import ActivityKit
import AppIntents
import Foundation

@available(iOS 17.0, *)
struct StartDiveIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Start dive"
    static var description = IntentDescription("Start timing a whale dive.")

    func perform() async throws -> some IntentResult {
        _ = DiveTimerStore.startDive()
        await refreshTripActivities()
        return .result()
    }
}

@available(iOS 17.0, *)
struct SurfacedIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Surfaced"
    static var description = IntentDescription("The whale surfaced. Stop the dive timer and record the dive.")

    func perform() async throws -> some IntentResult {
        _ = DiveTimerStore.surfaced()
        await refreshTripActivities()
        return .result()
    }
}

@available(iOS 17.0, *)
struct CancelDiveIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Cancel dive timing"
    static var description = IntentDescription("Stop timing without recording a dive.")

    func perform() async throws -> some IntentResult {
        DiveTimerStore.cancelDive()
        await refreshTripActivities()
        return .result()
    }
}

@available(iOS 16.2, *)
private func refreshTripActivities() async {
    for activity in Activity<TripActivityAttributes>.activities {
        var state = activity.content.state
        DiveTimerStore.pushDiveState(into: &state)
        await activity.update(ActivityContent(state: state, staleDate: nil))
    }
}
