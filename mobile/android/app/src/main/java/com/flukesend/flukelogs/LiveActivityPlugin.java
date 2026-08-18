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

    // Channels. Trip is low importance so the ongoing notice sits quietly;
    // Alerts is high so the dock question actually shows on the lock screen.
    static final String CH_TRIP = "flukelogs_trip";
    static final String CH_ALERTS = "flukelogs_alerts";
    static final int ID_TRIP = 4101;
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
        NotificationChannel trip = new NotificationChannel(CH_TRIP, "Trip in progress", NotificationManager.IMPORTANCE_LOW);
        trip.setDescription("Shown while Flukelogs is recording a trip.");
        NotificationChannel alerts = new NotificationChannel(CH_ALERTS, "Trip alerts", NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("Back at the dock reminders.");
        nm.createNotificationChannel(trip);
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
      Called by the web layer at Start Trip on both platforms. On Android 13+
      posting anything needs the runtime POST_NOTIFICATIONS grant, so ask
      here, at the same moment iOS asks (its plugin requests authorization in
      startTrip too), then post the ongoing card. Resolves {started:true}
      because the web layer reads that field to decide whether the native
      side is up; iOS uses it for Live Activity availability, here it means
      the ongoing notification exists.
    */
    @PluginMethod
    public void startTrip(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(getContext(), android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            pendingStart = call;
            call.setKeepAlive(true);
            requestPermissionForAlias("notifications", call, "onNotifPermission");
            return;
        }
        finishStart(call);
    }

    private PluginCall pendingStart;

    @com.getcapacitor.annotation.PermissionCallback
    private void onNotifPermission(PluginCall call) {
        // Post regardless of the answer: denied means the OS drops the card
        // silently and the app still records, which is the same behaviour a
        // captain who declined on iOS gets.
        finishStart(call);
    }

    private void finishStart(PluginCall call) {
        String boat = call.getString("boatName", "Flukelogs");
        postOngoing(boat, "Recording your route");
        JSObject r = new JSObject();
        r.put("started", true);
        call.resolve(r);
    }

    @PluginMethod
    public void updateTrip(PluginCall call) {
        String boat = call.getString("boatName", "Flukelogs");
        String pos = call.getString("positionText", null);
        Double nm = call.getDouble("distanceNm");
        StringBuilder line = new StringBuilder();
        if (pos != null && !pos.isEmpty()) line.append(pos);
        if (nm != null && nm > 0) { if (line.length() > 0) line.append("  ·  "); line.append(String.format("%.1f NM", nm)); }
        postOngoing(boat, line.length() > 0 ? line.toString() : "Recording your route");
        call.resolve();
    }

    @PluginMethod
    public void endTrip(PluginCall call) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(getContext());
        nm.cancel(ID_TRIP);
        nm.cancel(ID_FENCE);
        call.resolve();
    }

    @PluginMethod
    public void promptStillLogging(PluginCall call) {
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

    private void postOngoing(String title, String text) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(getContext(), CH_TRIP)
            .setSmallIcon(getContext().getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openApp(null, 4));
        try {
            NotificationManagerCompat.from(getContext()).notify(ID_TRIP, b.build());
        } catch (SecurityException ignored) {}
    }

    static LiveActivityPlugin current() { return instance; }
}
