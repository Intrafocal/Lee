import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "AppGroupBridge") {
      AppGroupBridge.register(messenger: registrar.messenger())
    }
  }
}

/// The active Machine for the share extension ("Lee" in the share sheet,
/// ios/LeeShare): Aeronaut writes it, the extension only reads it.
enum AppGroupBridge {
  static let suite = "group.com.intrafocal.aeronaut"
  static let keys = ["machine_host_url", "machine_token", "machine_name", "machine_workspace"]

  static func register(messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "aeronaut/app_group", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "setMachine", let defaults = UserDefaults(suiteName: suite) else {
        result(FlutterMethodNotImplemented)
        return
      }
      if let args = call.arguments as? [String: Any?] {
        for key in keys {
          if let v = args[key] as? String, !v.isEmpty { defaults.set(v, forKey: key) } else { defaults.removeObject(forKey: key) }
        }
      } else {
        keys.forEach { defaults.removeObject(forKey: $0) }
      }
      result(nil)
    }
  }
}
