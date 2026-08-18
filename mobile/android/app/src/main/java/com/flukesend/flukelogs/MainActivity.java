package com.flukesend.flukelogs;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/*
  App-local plugins are registered here by hand, never in packageClassList,
  which cap sync regenerates and would strip. Same rule as the iOS shell
  (MainViewController.swift) and the same trap it fell into first.

  onNewIntent forwards a relaunch from a notification tap to the plugin, so a
  fence answer riding on the intent reaches the web layer.
*/
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LiveActivityPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        LiveActivityPlugin p = LiveActivityPlugin.current();
        if (p != null) p.drainLaunchIntent(intent);
    }
}
