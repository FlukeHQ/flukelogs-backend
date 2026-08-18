package com.flukesend.flukelogs;

/*
  Android twin of the iOS LiveActivityPlugin. Same plugin name, same JS
  method names, same "fencePrompt" event with the same answers, so the web
  layer needs no branching: it calls window.Capacitor.Plugins.LiveActivity
  and whichever platform is underneath answers.

  What it does here, and what it deliberately does not.

  DOES: the two notification features iOS 1.3 shipped and Android never got.
    - promptStillLogging: the harbor fence question, "Back at the dock? Still
      logging whales?", posted as a heads-up notification with two action
      buttons, Still out watching / End the trip. Tapping the body opens the
      app and reports "opened", so the web layer asks the same question in
      page, exactly as on iOS.
    - An ongoing "Trip in progress" notification while a trip runs, started
      by startTrip and cleared by endTrip. Android has no Live Activity or
      Dynamic Island; a persistent notification is the honest equivalent and
      also what a captain glances at to confirm the app is still recording.

  DOES NOT: the dive timer. iOS keeps that in the Live Activity's App
  Intents, and there is no Android surface it belongs on yet. updateTrip is
  accepted and refreshes the ongoing notification's text, nothing more.

  Android is kinder than iOS on one point that cost days over there: a
  notification action runs with the phone locked and no unlock wall, so
  Still out / End the trip work from the lock screen with no caveats.

  Registered from MainActivity, by hand, for the same reason the iOS one is
  registered in MainViewController: app-local plugins are not in
  packageClassList and cap sync would strip them.
*/

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(
    name = "LiveActivity",
    permissions = {
        @com.getcapacitor.annotation.Permission(
            alias = "notifications",
            strings = { android.Manifest.permission.POST_NOTIFICATIONS }
        )
    }
)
public class LiveActivityPlugin extends Plugin {

    // One channel, high importance, so the dock question shows on the lock
    // screen. The recording-in-progress notification is the geolocation
    // plugin's foreground service, not ours (see startTrip).
    static final String CH_ALERTS = "flukelogs_alerts";
    static final int ID_FENCE = 4102;

    // Broadcast actions carried by the notification buttons. The receiver
    // below turns them into fencePrompt events; a static reference lets a
    // button tap reach the running plugin even when the app was backgrounded.
    static final String ACTION_STILL_OUT = "com.flukesend.flukelogs.STILL_OUT";
    static final String ACTION_END_TRIP = "com.flukesend.flukelogs.END_TRIP";
    static final String ACTION_OPENED = "com.flukesend.flukelogs.FENCE_OPENED";
    static final String EXTRA_FENCE = "fence_answer";

    private static LiveActivityPlugin instance;
    private BroadcastReceiver receiver;

    @Override
    public void load() {
        instance = this;
        ensureChannels();
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (action == null) return;
                if (ACTION_STILL_OUT.equals(action)) emitFence("still_out");
                else if (ACTION_END_TRIP.equals(action)) emitFence("end_trip");
            }
        };
        IntentFilter f = new IntentFilter();
        f.addAction(ACTION_STILL_OUT);
        f.addAction(ACTION_END_TRIP);
        ContextCompat.registerReceiver(getContext(), receiver, f, ContextCompat.RECEIVER_NOT_EXPORTED);
        // A tap on the fence notification's body relaunches MainActivity with
        // the answer as an extra; MainActivity hands it here on resume.
        drainLaunchIntent(getActivity() != null ? getActivity().getIntent() : null);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        drainLaunchIntent(intent);
    }

    /* Consumes a fence answer riding on a launch intent, once. */
    void drainLaunchIntent(Intent intent) {
        if (intent == null) return;
        String ans = intent.getStringExtra(EXTRA_FENCE);
        if (ans == null) return;
        intent.removeExtra(EXTRA_FENCE);
        emitFence(ans);
    }

    private void emitFence(String answer) {
        JSObject data = new JSObject();
        data.put("answer", answer);
        // retainUntilConsumed: a tap that launches the app fires before the
        // web layer has registered its listener; the event waits for it. Same
        // lesson iOS learned on 2026-08-11.
        notifyListeners("fencePrompt", data, true);
        // Either answer resolves the question; take the card down.
        NotificationManagerCompat.from(getContext()).cancel(ID_FENCE);
    }

    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getContext().getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel alerts = new NotificationChannel(CH_ALERTS, "Trip alerts", NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("Back at the dock reminders.");
        nm.createNotificationChannel(alerts);
    }

    private PendingIntent broadcast(String action, int req) {
        Intent i = new Intent(action).setPackage(getContext().getPackageName());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(getContext(), req, i, flags);
    }

    private PendingIntent openApp(String fenceAnswer, int req) {
        Intent i = new Intent(getContext(), MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (fenceAnswer != null) i.putExtra(EXTRA_FENCE, fenceAnswer);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(getContext(), req, i, flags);
    }

    // ── JS surface, mirroring iOS ────────────────────────────────────

    /*
      Called by the web layer at Start Trip on both platforms.

      1.1.0 asked for POST_NOTIFICATIONS right here, and it broke GPS on the
      one Android phone we have. Start Trip is also the moment the
      background-geolocation plugin requests location, and two runtime
      permission dialogs fired together on Android means one of them loses:
      MJ's location grant lost, the plugin fell back to coarse network fixes,
      and her 2026-08-18 morning trip recorded four points in two hours where
      the day before, on 1.0.1, the same phone recorded 500. Same boat, same
      phone, one day apart. The update was the only variable.

      So this NEVER asks for anything. It posts the ongoing card if it is
      allowed to, and if it is not allowed the card is simply absent, which
      is what iOS does for a captain who declined. Recording does not depend
      on notifications and must never wait on them. The notification ask
      moved to promptStillLogging, the first moment a notification is
      actually needed, which is at the dock, long after location settled.
    */
    /*
      startTrip and updateTrip post NOTHING on Android as of 1.1.2.

      The background-geolocation plugin runs a foreground service, and a
      foreground service on Android IS a persistent notification: that is the
      "Trip in progress" card captains already saw on 1.0.1, and it is the
      mechanism that keeps location alive with the screen off. 1.1.0 posted a
      second ongoing card from this plugin, on its own channel, and the two
      fought. The plugin's service was disrupted and background location went
      with it: four points in two hours on a phone that recorded 500 the day
      before. One ongoing notification per app, and it belongs to the thing
      doing the recording. This plugin keeps only the dock prompt.
    */
    @PluginMethod
    public void startTrip(PluginCall call) {
        JSObject r = new JSObject();
        r.put("started", true);
        call.resolve(r);
    }

    private boolean canPost() {
        return Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(getContext(), android.Manifest.permission.POST_NOTIFICATIONS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void updateTrip(PluginCall call) {
        // Accepted for API parity with iOS; nothing to update on Android now
        // that the ongoing card belongs to the geolocation service.
        call.resolve();
    }

    @PluginMethod
    public void endTrip(PluginCall call) {
        NotificationManagerCompat.from(getContext()).cancel(ID_FENCE);
        call.resolve();
    }

    /*
      The dock question. This is where the notification permission is asked,
      if it has not been yet: it is the first time the app needs to post
      anything the captain must see, and by now location has been settled for
      an entire trip, so there is no dialog for it to collide with. If they
      decline, the web layer's in-app fallback still asks the question on the
      screen the next time the app is opened, so nothing is lost but the
      lock screen shortcut.
    */
    @PluginMethod
    public void promptStillLogging(PluginCall call) {
        if (!canPost()) {
            call.setKeepAlive(true);
            requestPermissionForAlias("notifications", call, "onNotifPermissionThenPrompt");
            return;
        }
        postFencePrompt(call);
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void onNotifPermissionThenPrompt(PluginCall call) {
        postFencePrompt(call);
    }

    private void postFencePrompt(PluginCall call) {
        String title = call.getString("title", "Back at the dock?");
        String body = call.getString("body", "Still logging whales?");
        NotificationCompat.Builder b = new NotificationCompat.Builder(getContext(), CH_ALERTS)
            .setSmallIcon(getContext().getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(openApp("opened", 3))
            .addAction(0, "Still out watching", broadcast(ACTION_STILL_OUT, 1))
            .addAction(0, "End the trip", broadcast(ACTION_END_TRIP, 2));
        try {
            NotificationManagerCompat.from(getContext()).notify(ID_FENCE, b.build());
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS not granted on 13+. The web layer treats a
            // silent failure as "no native prompt available", same as iOS.
        }
        call.resolve();
    }

    @PluginMethod
    public void clearStillLogging(PluginCall call) {
        NotificationManagerCompat.from(getContext()).cancel(ID_FENCE);
        call.resolve();
    }


    static LiveActivityPlugin current() { return instance; }
}
