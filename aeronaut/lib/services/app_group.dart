import 'package:flutter/services.dart';

import '../models/machine.dart';

/// Shares the active Machine with the iOS share extension ("Lee" in the
/// share sheet, ios/LeeShare) through the App Group; see AppDelegate.swift.
/// A no-op where there's no native side (tests, other platforms).
class AppGroup {
  static const _channel = MethodChannel('aeronaut/app_group');

  static Future<void> publishMachine(Machine? m) async {
    try {
      await _channel.invokeMethod<void>(
        'setMachine',
        m == null
            ? null
            : {
                'machine_host_url': m.hostUrl,
                'machine_token': m.token,
                'machine_name': m.name,
                'machine_workspace': m.workspace,
              },
      );
    } on MissingPluginException {
      // Not on iOS, or in a test.
    } on PlatformException {
      // No App Group (an unsigned build): the share extension says to pair first.
    }
  }
}
