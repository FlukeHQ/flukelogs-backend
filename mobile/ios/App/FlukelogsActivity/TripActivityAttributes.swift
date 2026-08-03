//
//  TripActivityAttributes.swift
//  Shared between the App target and the FlukelogsActivity widget extension.
//  Membership: BOTH targets, or neither side can talk about the same activity.
//
//  The activity's fixed attributes are set once at Start Trip; everything that
//  changes during the trip rides in ContentState. Timers are self ticking:
//  the card renders tripStartedAt and diveStartedAt with Text(timerInterval:),
//  so the system draws every tick and the app never spends an update on time.
//

import ActivityKit
import Foundation

struct TripActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        // Position line, already formatted by the app in plotter format
        // ("N 36 47.331  W 121 50.570") so native and web can never disagree
        // about coordinate display. Empty until the first GPS fix.
        var positionText: String
        var distanceNm: Double
        // Dive cycle. nil diveStartedAt means no dive is being timed.
        var diveStartedAt: Date?
        // Expected surfacing moment for the running dive, when at least one
        // completed dive this encounter taught us a rhythm. Drives the
        // "expect surfacing" line and the past-expected state.
        var expectedSurfacing: Date?
        // The last completed dive, shown while idle so the crew keeps the
        // rhythm in view between cycles.
        var lastDiveSeconds: Int?
    }

    // Set once when the trip starts.
    var tripStartedAt: Date
    var boatName: String
}
