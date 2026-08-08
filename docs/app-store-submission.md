# App Store submission pack (Phase 4)

Copy-paste reference for App Store Connect. Fill the placeholders marked
`<< >>` with values only you can provide. No em dashes anywhere (house rule).

---

## 1. App identity

| Field | Value |
|-------|-------|
| App name | Flukelogs |
| Subtitle (<=30 chars) | Log trips, routes and sightings |
| Bundle ID | com.flukesend.flukelogs |
| Primary category | Business |
| Secondary category | Travel |
| Age rating | 4+ |
| Price | Free |

> Name note: "Flukelogs" is 9 chars (limit 30). The subtitle above is 31
> with the word "and"; if App Store Connect rejects it, use "Log trips, routes, sightings" (28).

---

## 2. Promotional text (<=170 chars, editable any time without review)

> Record every trip from the water: live GPS route, distance, and wildlife
> sightings, then send guests a clean trip report. Built for whale watch crews.

---

## 3. Description (<=4000 chars)

Enocean Tours Trip Logger is the on-the-water tool for whale watch and marine
wildlife crews. Start a trip, and the app records your vessel's route by GPS,
tracks distance traveled, and lets you log wildlife sightings as they happen,
all from your phone.

WHAT YOU CAN DO

- Start a trip and automatically record your route, even while the screen is
  locked and the phone is in your pocket.
- Log sightings on the fly: species, counts, times, notes, photos, and audio.
- Capture conditions like water temperature and sea state.
- Pre-fill passenger details from your connected booking system.
- Send guests a polished trip report after the trip, including the route and
  the species seen.
- Show a public sightings feed on your website, with the option to hide precise
  locations from competitors.

BUILT FOR CREWS

The app keeps recording your route in the background during an active trip, so
your distance and breadcrumb path stay accurate for the whole tour. Location is
only collected while a trip is running and stops when you end the trip.

Enocean Tours Trip Logger is a tool for tour operators and their crew. An
operator account is required to use the app.

---

## 4. Keywords (<=100 chars total, comma separated, no spaces)

```
whale watching,trip log,wildlife,sightings,boat,gps,marine,naturalist,ocean,logbook,tour
```
(91 chars. Do not repeat the app name or category words; Apple ignores those.)

---

## 5. URLs

| Field | Value |
|-------|-------|
| Privacy Policy URL | https://trip-logger-backend.vercel.app/privacy.html |
| Support URL | << your support page, e.g. https://enoceantours.com/support or a mailto page >> |
| Marketing URL (optional) | << e.g. https://enoceantours.com >> |

> Apple requires a Support URL. If you do not have a support page, a simple page
> with a contact email works, or I can add a `/support.html` like the privacy page.

---

## 6. What's New

### Version 1.1 (current submission)

> Time a whale's dive from your lock screen, without unlocking your phone.
> Flukelogs learns each animal's rhythm through the encounter and chimes just
> before she is likely to surface, so cameras are up in time.
>
> Your trip time, position and distance run now show on the lock screen and in
> the Dynamic Island, so you can check a trip without opening the app.
>
> Also fixes a gap at the bottom of the screen on newer iPhones.

Note on scope: only the two items above need this binary. The Start Trip
redesign, the Whale Log fluke thumbnails and the rest of the season's work
reached captains through the web layer already, since the shell loads
`server.url`. Do not list those here as new; they have been live for weeks and
claiming them would read as padding.

### Version 1.0

> First release of Enocean Tours Trip Logger: GPS route recording, wildlife
> sighting logging, and guest trip reports.

---

## 7. App Privacy (the data nutrition label questionnaire)

Answer Apple's "App Privacy" section as follows. We use no third party ad or
analytics SDKs, so nothing is used for tracking.

**Do you or your partners collect data from this app?** Yes.

**Data types collected, and for each: purpose = App Functionality, Linked to
the user = Yes, Used for tracking = No.**

| Apple data type | Collected | Notes |
|-----------------|-----------|-------|
| Contact Info > Email Address | Yes | Account sign-in; booking customer emails |
| Location > Precise Location | Yes | Trip route only, incl. background during a trip |
| User Content > Photos or Videos | Yes | Sighting photos |
| User Content > Audio Data | Yes | Sighting audio notes |
| User Content > Other User Content | Yes | Sighting species, counts, notes |
| Identifiers | No | No advertising or device identifiers used |
| Usage Data | No | No analytics SDK |
| Diagnostics | No | No crash/analytics SDK bundled |

**Tracking (App Tracking Transparency):** No data is used to track users across
apps or websites owned by other companies. You do NOT need an ATT prompt.

**Data used to track you:** None.
**Data linked to you:** Email, Precise Location, Photos, Audio, Other User Content.
**Data not linked to you:** None.

---

## 8. App Review information (reviewer notes)

Paste into App Store Connect > App Review Information > Notes. Kept current
here so it does not have to be rewritten from memory each submission.

The demo account email is below; the password lives in the founder's password
manager, deliberately not in this repo. A reviewer cannot test without it, so
check both fields are filled in App Store Connect before submitting.

```
Flukelogs is a business tool for marine tour operators and their crew. Accounts
are provisioned by the operator, there is no public sign up, and the app is
distributed unlisted (approved by Developer Support, case 102937531840). The
Code of Conduct matter from earlier submissions was resolved by the App Review
Board under APL512795.

DEMO ACCOUNT
  Email:    appreview@enoceantours.com
  Password: << from the password manager >>
  Signs in to Bayside Whale Watch, a demo operator with sample trips.

NEW IN THIS VERSION: LIVE ACTIVITY AND NOTIFICATIONS
A trip now shows as a Live Activity on the lock screen and in the Dynamic
Island, carrying the trip clock, position and distance run. It also carries a
dive timer: whales dive for minutes at a time, and a captain timing those
dives can predict the next surfacing and get the guests' cameras up. The
buttons are App Intents so the crew never has to unlock a wet phone at the
rail.

Unlike the background location below, this CAN be exercised at a desk:

  1. Sign in with the demo account. Accept the location disclosure that
     appears the first time (scroll to the end, tick the box, agree).
  2. Tap Start Trip. No movement needed, and nothing else has to be chosen:
     the departure is already filled in from the operator's booking system.
  3. Lock the phone. The Flukelogs card is on the lock screen.
  4. Tap "Start dive". The card switches to a running dive timer with
     "Surfaced" and a cancel button, all without unlocking.
  5. Tap "Surfaced". The dive is recorded and the card goes back to
     "Start dive", now showing how long that dive lasted.
  6. Reopen the app and tap End Trip to clear the card.

The notification permission prompt at Start Trip is for one thing: a local
chime a few seconds before the whale is predicted to surface. It is optional.
Declining it leaves every other part of the app working, including the Live
Activity itself. No push server is involved and no remote notifications are
sent; the Live Activity is updated locally by the app.

MICROPHONE (unchanged from the approved build)
Captains record a short spoken recap of a trip, which guests play from the
operator's public sightings page. Nothing else uses the microphone and it is
never accessed in the background.

  1. Open the menu and tap Past Trips.
  2. Tap the July 18 trip. It already has a saved note, shown as
     "Audio · 0:18", which plays in place.
  3. To record a new one, tap "Tap to record", speak, stop, then Save audio.

BACKGROUND LOCATION (unchanged from the approved build)
The app requests Always location so it keeps recording the vessel's route
while the screen is locked during a trip. This is the core function: the
route, the distance in nautical miles, and the operator's live boat map all
depend on it. Location is collected only while a trip is running, stops at
End Trip, and is never used for advertising or sold. It cannot be exercised
at a desk, since it requires starting a trip and physically moving while the
app is backgrounded.

  1. Sign in, choose a boat and departure, tap Start Trip.
  2. Background the app and move a short distance.
  3. Reopen: distance and the recorded track have both grown.

CAMERA AND PHOTO LIBRARY
Captains attach photos to a trip gallery, shown on the operator's public
sightings page. Reached from the same Past Trips screen as the voice note.

NO EMAIL IS SENT FROM THIS APP
Everything the app records (route, sightings, voice note, gallery photos)
publishes to the operator's own sightings page. That is the app's complete
function and needs nothing else to work. Sending photos on to guests is a
separate task operators do in Flukesend, our own web product, and the link on
the screen after a trip is logged is only a shortcut there. It opens in Safari
and is not needed for anything in the app. There is no sign up, subscription,
or purchase anywhere in the app.
```

If the camera and photo library usage strings are not in the build being
submitted, drop that last paragraph.

---

## 9. Export compliance

When prompted at upload: the app uses only standard HTTPS/TLS encryption and no
proprietary or non-standard cryptography. Answer the encryption question
accordingly (uses standard encryption, exempt). I will confirm the exact
toggle when we archive.

---

## 10. Still needed from you (checklist)

For the 1.1 submission specifically:

- [ ] Demo account password filled into App Store Connect. A reviewer cannot
      sign in without it, and every step of the Live Activity walkthrough
      above starts with signing in.
- [ ] Confirm the demo operator still has the July 18 trip with the saved
      audio note, since the microphone walkthrough names it.

Carried over from 1.0:

- [ ] Support URL (or let me add a `/support.html`)
- [ ] Demo captain account (email + password) for the reviewer
- [ ] Screenshots from a real device (I will tell you which screens and sizes)
- [ ] Confirm primary category Business (vs Travel)
- [ ] Confirm the sub-processor list in the privacy policy
