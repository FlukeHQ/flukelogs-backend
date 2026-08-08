//
//  FlukelogsActivityWidget.swift
//  Membership: FlukelogsActivity target only. The card itself.
//
//  Lock screen: trip clock, position in plotter format, and the dive row.
//  Dynamic Island: dive clock while a dive runs, trip clock otherwise.
//  Timers are Text(timerInterval:) so the system ticks them for free.
//

import ActivityKit
// The dive row's buttons are Button(intent:), which lives in AppIntents.
// DiveIntents.swift imports it; this file uses the initializer, so it needs
// the import too. Missing here since the code was written, because the
// widget target did not exist to compile it until now.
import AppIntents
import SwiftUI
import WidgetKit

@main
struct FlukelogsActivityBundle: WidgetBundle {
    var body: some Widget {
        FlukelogsActivityWidget()
    }
}

struct FlukelogsActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TripActivityAttributes.self) { context in
            LockScreenCard(context: context)
                .activityBackgroundTint(Color.black.opacity(0.85))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(context.attributes.boatName, systemImage: "sailboat.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    TripClock(startedAt: context.attributes.tripStartedAt)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.white)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    DiveRow(state: context.state)
                }
            } compactLeading: {
                Image(systemName: context.state.diveStartedAt == nil ? "sailboat.fill" : "water.waves.and.arrow.down")
                    .foregroundStyle(.cyan)
            } compactTrailing: {
                if let diveStart = context.state.diveStartedAt {
                    Text(timerInterval: diveStart...farFuture, countsDown: false)
                        .font(.caption2.monospacedDigit())
                        .frame(maxWidth: 44)
                        .foregroundStyle(.cyan)
                } else {
                    TripClock(startedAt: context.attributes.tripStartedAt)
                        .font(.caption2.monospacedDigit())
                        .frame(maxWidth: 44)
                }
            } minimal: {
                Image(systemName: "sailboat.fill").foregroundStyle(.cyan)
            }
        }
    }
}

private var farFuture: Date { Date(timeIntervalSinceNow: 60 * 60 * 24) }

private struct TripClock: View {
    let startedAt: Date
    var body: some View {
        Text(timerInterval: startedAt...farFuture, countsDown: false)
            .monospacedDigit()
    }
}

private struct LockScreenCard: View {
    let context: ActivityViewContext<TripActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Label("FLUKELOGS", systemImage: "sailboat.fill")
                    .font(.caption2.weight(.bold))
                    .tracking(1.2)
                    .foregroundStyle(.cyan)
                Spacer()
                HStack(spacing: 4) {
                    Image(systemName: "timer")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    TripClock(startedAt: context.attributes.tripStartedAt)
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(.white)
                }
            }

            if !context.state.positionText.isEmpty {
                HStack(spacing: 8) {
                    Text(context.state.positionText)
                        .font(.footnote.monospaced())
                        .foregroundStyle(.white.opacity(0.9))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    if context.state.distanceNm > 0 {
                        Text(String(format: "%.1f NM", context.state.distanceNm))
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            }

            DiveRow(state: context.state)
        }
        .padding(14)
    }
}

// The dive cycle row, shared by the lock screen and the expanded island.
private struct DiveRow: View {
    let state: TripActivityAttributes.ContentState

    var body: some View {
        if let diveStart = state.diveStartedAt {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 10) {
                    Text("DIVE")
                        .font(.caption2.weight(.bold))
                        .tracking(1.2)
                        .foregroundStyle(.cyan)
                    Text(timerInterval: diveStart...farFuture, countsDown: false)
                        .font(.title3.weight(.bold).monospacedDigit())
                        .foregroundStyle(.white)
                        .frame(maxWidth: 74, alignment: .leading)
                    Spacer()
                    if #available(iOS 17.0, *) {
                        Button(intent: SurfacedIntent()) {
                            Text("Surfaced").font(.footnote.weight(.semibold))
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.cyan)
                        Button(intent: CancelDiveIntent()) {
                            Image(systemName: "xmark")
                                .font(.footnote.weight(.bold))
                        }
                        .buttonStyle(.bordered)
                        .tint(.red)
                    }
                }
                ExpectationLine(diveStart: diveStart, expected: state.expectedSurfacing)
            }
        } else {
            HStack {
                if let last = state.lastDiveSeconds {
                    Text("last dive \(last / 60):\(String(format: "%02d", last % 60))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if #available(iOS 17.0, *) {
                    Button(intent: StartDiveIntent()) {
                        Label("Start dive", systemImage: "water.waves.and.arrow.down")
                            .font(.footnote.weight(.semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.cyan)
                }
            }
        }
    }
}

// "expect surfacing ~5:00 · chime armed" while inside the prediction, then
// an honest "past expected" once the whale breaks pattern. Rendered with a
// self updating date comparison so the flip happens without an update.
private struct ExpectationLine: View {
    let diveStart: Date
    let expected: Date?

    var body: some View {
        if let expected {
            let mins = Int(expected.timeIntervalSince(diveStart)) / 60
            let secs = Int(expected.timeIntervalSince(diveStart)) % 60
            // Past-expected flips by comparing against the timeline the
            // system renders; one minute of grace before calling it long.
            if Date() > expected.addingTimeInterval(60) {
                Text("past expected \(mins):\(String(format: "%02d", secs)), she's gone long")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            } else {
                Text("expect surfacing ~\(mins):\(String(format: "%02d", secs)) · chime armed")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        } else {
            Text("first dive of this encounter, timing the rhythm")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}
