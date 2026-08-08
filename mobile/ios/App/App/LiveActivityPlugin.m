//
//  LiveActivityPlugin.m
//  Capacitor plugin registration. App target only.
//

#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(LiveActivityPlugin, "LiveActivity",
  CAP_PLUGIN_METHOD(startTrip, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(updateTrip, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(endTrip, CAPPluginReturnPromise);
)
