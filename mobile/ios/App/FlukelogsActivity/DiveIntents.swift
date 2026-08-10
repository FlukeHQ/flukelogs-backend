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
    /*
      Without this the button asks for the passcode.

      LiveActivityIntent is necessary but not sufficient: it lets the intent
      run from the card, while authenticationPolicy decides whether the device
      has to be unlocked first, and it defaults to .requiresAuthentication.
      So the buttons appeared, and tapping one demanded Face ID or a passcode,
      which is the exact thing this feature exists to avoid. A captain with wet
      hands and a whale down is not authenticating.

      .alwaysAllowed is safe for these three. They write a timestamp to the
      app group and repaint the card. Nothing is read out, nothing personal is
      shown, and nothing is destructive: the worst a stranger holding the phone
      can do is start or stop a dive timer on a trip already visible to anyone
      looking at the lock screen.
    */
    static var authenticationPolicy: IntentAuthenticationPolicy { .alwaysAllowed }

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
    /*
      Without this the button asks for the passcode.

      LiveActivityIntent is necessary but not sufficient: it lets the intent
      run from the card, while authenticationPolicy decides whether the device
      has to be unlocked first, and it defaults to .requiresAuthentication.
      So the buttons appeared, and tapping one demanded Face ID or a passcode,
      which is the exact thing this feature exists to avoid. A captain with wet
      hands and a whale down is not authenticating.

      .alwaysAllowed is safe for these three. They write a timestamp to the
      app group and repaint the card. Nothing is read out, nothing personal is
      shown, and nothing is destructive: the worst a stranger holding the phone
      can do is start or stop a dive timer on a trip already visible to anyone
      looking at the lock screen.
    */
    static var authenticationPolicy: IntentAuthenticationPolicy { .alwaysAllowed }

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
    /*
      Without this the button asks for the passcode.

      LiveActivityIntent is necessary but not sufficient: it lets the intent
      run from the card, while authenticationPolicy decides whether the device
      has to be unlocked first, and it defaults to .requiresAuthentication.
      So the buttons appeared, and tapping one demanded Face ID or a passcode,
      which is the exact thing this feature exists to avoid. A captain with wet
      hands and a whale down is not authenticating.

      .alwaysAllowed is safe for these three. They write a timestamp to the
      app group and repaint the card. Nothing is read out, nothing personal is
      shown, and nothing is destructive: the worst a stranger holding the phone
      can do is start or stop a dive timer on a trip already visible to anyone
      looking at the lock screen.
    */
    static var authenticationPolicy: IntentAuthenticationPolicy { .alwaysAllowed }

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
