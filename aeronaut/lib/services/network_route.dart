import 'dart:io';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:http/http.dart' as http;

import '../models/machine.dart';

/// Whether this device is on the tailnet right now: Tailscale gives it an
/// interface with a 100.64.0.0/10 address while it's connected. On the web
/// there's no way to tell, so assume not and let the fallback find the way.
Future<bool> deviceOnTailnet() async {
  if (kIsWeb) return false;
  try {
    final interfaces = await NetworkInterface.list(type: InternetAddressType.IPv4);
    return interfaces.any((i) => i.addresses.any((a) => Machine.isTailnetAddress(a.address)));
  } catch (_) {
    return false;
  }
}

/// The first of [hosts] whose Lee answers `/health` (unauthenticated) on
/// [port], or null when none does. Used at pairing, before there's a token.
Future<String?> firstReachableHost(List<String> hosts, int port) async {
  final client = http.Client();
  try {
    for (final host in hosts) {
      try {
        final response = await client
            .get(Uri.parse('http://$host:$port/health'))
            .timeout(const Duration(seconds: 3));
        if (response.statusCode == 200) return host;
      } catch (_) {
        // Try the next address.
      }
    }
    return null;
  } finally {
    client.close();
  }
}
