//
//  DiveIntents.swift
//  Membership: BOTH targets.
//
//  The lock screen buttons. Each intent flips the dive state in
//  DiveTimerStore; the card reads that state straight from the app group at
//  render time, so the re-render the system performs after an intent is
//  enough to repaint it.
//
//  WHY THESE ARE PLAIN AppIntents AND NOT LiveActivityIntent, learned on a
//  passcode phone on 2026-08-09 after two App Store rounds:
//
//  LiveActivityIntent runs in the APP process. Launching a third party app
//  process from a locked phone requires authentication, an iOS rule that
//  sits ABOVE authenticationPolicy, which is why .alwaysAllowed changed
//  nothing and why the passcode-less simulator ran the buttons fine while
//  every real phone demanded Face ID. A plain AppIntent that lives in the
//  widget extension runs IN the extension, which is already trusted to draw
//  the lock screen, so nothing needs unlocking.
//
//  The cost: an extension cannot push ActivityKit updates, so perform() does
//  not repaint the card by calling ActivityKit. The card repaints because
//  the system re-renders a Live Activity after one of its intents runs, and
//  the view reads DiveTimerStore directly.
//

import AppIntents
import Foundation

@available(iOS 17.0, *)
struct StartDiveIntent: AppIntent {
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
        return .result()
    }
}

@available(iOS 17.0, *)
struct SurfacedIntent: AppIntent {
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
        return .result()
    }
}

@available(iOS 17.0, *)
struct CancelDiveIntent: AppIntent {
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
        return .result()
    }
}

