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

// The app's palette, same values as the CSS custom properties at the top of
// trip-logger/index.html. Moon white is the primary CTA (the LOG SIGHTING
// button), teal is the live/accent colour (the broadcasting pill), ink is the
// page. Keep these in step with the web side.
// Constrained to ShapeStyle so the leading-dot form works inside
// foregroundStyle/tint, the same way SwiftUI declares .red and .primary.
// A plain `extension Color` compiles but every call site fails to resolve.
private extension ShapeStyle where Self == Color {
    static var brandInk: Color { Color(red: 0.039, green: 0.047, blue: 0.055) }   // #0a0c0e
    static var brandCream: Color { Color(red: 0.902, green: 0.941, blue: 0.941) } // #e6f0f0
    static var brandTeal: Color { Color(red: 0.435, green: 0.694, blue: 0.675) }  // #6fb1ac
}

// The pin-and-fluke mark, cut from the same wordmark art the app header uses.
// Template rendered, so it takes whatever foreground style it is given.
private struct FlukeMark: View {
    var size: CGFloat = 14
    var body: some View {
        Image("FlukeMark")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
    }
}

// Mark plus "Flukelogs", the same lockup as the app header. 4.67:1.
private struct FlukelogsWordmark: View {
    var height: CGFloat = 12
    var body: some View {
        Image("FlukelogsWordmark")
            .resizable()
            .scaledToFit()
            .frame(height: height)
    }
}

struct FlukelogsActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TripActivityAttributes.self) { context in
            LockScreenCard(context: context, dive: resolvedDive(context.state))
                .activityBackgroundTint(Color.brandInk.opacity(0.92))
                .activitySystemActionForegroundColor(.brandCream)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 5) {
                        FlukeMark(size: 13).foregroundStyle(.brandCream)
                        Text(context.attributes.boatName)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.brandCream)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    TripClock(startedAt: context.attributes.tripStartedAt)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.brandCream)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    DiveRow(state: resolvedDive(context.state))
                }
            } compactLeading: {
                // The mark while under way; the dive glyph while one is timed,
                // so a glance at the island says which state the boat is in.
                if context.state.diveStartedAt == nil {
                    FlukeMark(size: 15).foregroundStyle(.brandCream)
                } else {
                    Image(systemName: "water.waves.and.arrow.down")
                        .foregroundStyle(.brandTeal)
                }
            } compactTrailing: {
                if let diveStart = resolvedDive(context.state).diveStartedAt {
                    Text(timerInterval: diveStart...farFuture, countsDown: false)
                        .font(.caption2.monospacedDigit())
                        .frame(maxWidth: 44)
                        .foregroundStyle(.brandTeal)
                } else {
                    TripClock(startedAt: context.attributes.tripStartedAt)
                        .font(.caption2.monospacedDigit())
                        .frame(maxWidth: 44)
                        .foregroundStyle(.brandCream)
                }
            } minimal: {
                FlukeMark(size: 15).foregroundStyle(.brandCream)
            }
        }
    }
}

private var farFuture: Date { Date(timeIntervalSinceNow: 60 * 60 * 24) }

/*
  The dive fields, resolved from DiveTimerStore at RENDER time rather than
  trusted from the pushed ContentState.

  This is the other half of the plain-AppIntent design (see DiveIntents.swift):
  the buttons run in the extension and cannot push ActivityKit updates, so the
  system's post-intent re-render is what repaints the card, and the view has
  to read the truth itself. The store is also simply more current than the
  push: the app updates ContentState at most every 30 seconds, the store is
  written the instant a button is tapped.
*/
private func resolvedDive(_ s: TripActivityAttributes.ContentState) -> TripActivityAttributes.ContentState {
    var c = s
    DiveTimerStore.pushDiveState(into: &c)
    return c
}

private struct TripClock: View {
    let startedAt: Date
    var body: some View {
        Text(timerInterval: startedAt...farFuture, countsDown: false)
            .monospacedDigit()
    }
}

private struct LockScreenCard: View {
    let context: ActivityViewContext<TripActivityAttributes>
    let dive: TripActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Centre, not firstTextBaseline: the wordmark is an image and has
            // no baseline to align the clock to.
            HStack(alignment: .center) {
                FlukelogsWordmark(height: 13)
                    .foregroundStyle(.brandCream)
                Spacer()
                HStack(spacing: 4) {
                    Image(systemName: "timer")
                        .font(.caption2)
                        .foregroundStyle(.brandCream.opacity(0.55))
                    TripClock(startedAt: context.attributes.tripStartedAt)
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(.brandCream)
                }
            }

            if !context.state.positionText.isEmpty {
                HStack(spacing: 8) {
                    Text(context.state.positionText)
                        .font(.footnote.monospaced())
                        .foregroundStyle(.brandCream.opacity(0.9))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    if context.state.distanceNm > 0 {
                        Text(String(format: "%.1f NM", context.state.distanceNm))
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.brandTeal)
                    }
                }
            }

            DiveRow(state: dive)
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
                        .foregroundStyle(.brandTeal)
                    Text(timerInterval: diveStart...farFuture, countsDown: false)
                        .font(.title3.weight(.bold).monospacedDigit())
                        .foregroundStyle(.brandCream)
                        .frame(maxWidth: 74, alignment: .leading)
                    Spacer()
                    if #available(iOS 17.0, *) {
                        // Moon white with ink text, the app's primary CTA.
                        Button(intent: SurfacedIntent()) {
                            Text("Surfaced")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.brandInk)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.brandCream)
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
                        .foregroundStyle(.brandCream.opacity(0.6))
                }
                Spacer()
                if #available(iOS 17.0, *) {
                    Button(intent: StartDiveIntent()) {
                        Label("Start dive", systemImage: "water.waves.and.arrow.down")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.brandInk)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.brandCream)
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
                    .foregroundStyle(.brandCream.opacity(0.6))
            }
        } else {
            Text("first dive of this encounter, timing the rhythm")
                .font(.caption2)
                .foregroundStyle(.brandCream.opacity(0.6))
        }
    }
}
