import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/lee_context.dart';
import '../models/machine.dart';

/// HTTP client for a Lee Host instance.
///
/// Wraps the Host API (default port 9001):
/// - GET /health
/// - GET /context
/// - POST /command
class LeeApi {
  final Machine machine;
  final http.Client _client;

  LeeApi({required this.machine, http.Client? client})
      : _client = client ?? http.Client();

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (machine.token.isNotEmpty)
          'Authorization': 'Bearer ${machine.token}',
      };

  /// Health check. Returns true if the host is reachable and healthy.
  Future<bool> healthCheck() async {
    try {
      final response = await _client
          .get(
            Uri.parse('${machine.hostUrl}/health'),
            headers: _headers,
          )
          .timeout(const Duration(seconds: 3));
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Fetch a full context snapshot.
  Future<LeeContext?> getContext() async {
    try {
      final response = await _client
          .get(
            Uri.parse('${machine.hostUrl}/context'),
            headers: _headers,
          )
          .timeout(const Duration(seconds: 5));
      if (response.statusCode == 200) {
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        return LeeContext.fromJson(json);
      }
    } catch (_) {
      // Connection failed
    }
    return null;
  }

  /// Send a command to the Lee Host.
  ///
  /// Example:
  /// ```dart
  /// await api.sendCommand('system', 'focus_tab', {'tab_id': 2});
  /// ```
  Future<bool> sendCommand(
    String domain,
    String action, [
    Map<String, dynamic>? params,
  ]) async {
    try {
      final body = jsonEncode({
        'domain': domain,
        'action': action,
        if (params != null) 'params': params,
      });
      final response = await _client
          .post(
            Uri.parse('${machine.hostUrl}/command'),
            headers: _headers,
            body: body,
          )
          .timeout(const Duration(seconds: 5));
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  void dispose() {
    _client.close();
  }
}
