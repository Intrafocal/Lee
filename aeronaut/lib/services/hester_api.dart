import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/hester_models.dart';
import '../models/machine.dart';
import 'api_auth.dart';

/// HTTP client for a Hester daemon instance.
///
/// Wraps the Hester API (default port 9000):
/// - GET  /health
/// - POST /context/stream  (SSE streaming)
/// - GET  /sessions
/// - GET  /session/:id/history
/// - DELETE /session/:id
/// - GET  /bundles
/// - GET  /bundles/:id
///
/// Every route but `GET /health` requires `Authorization: Bearer <token>`
/// (the same `~/.lee/api-token` Lee uses). A 401 is reported to [ApiAuth].
/// Thrown when Hester rejects the bearer token, so the chat UI can show the
/// re-pair message instead of a generic connection error.
class HesterAuthException implements Exception {
  const HesterAuthException();

  @override
  String toString() => AuthFailure.message;
}

class HesterApi {
  final Machine machine;
  final http.Client _client;

  HesterApi({required this.machine, http.Client? client})
      : _client = client ?? http.Client();

  String? get _baseUrl => machine.hesterUrl;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (machine.token.isNotEmpty)
          'Authorization': 'Bearer ${machine.token}',
      };

  /// True when the response was a token rejection; reports it once.
  bool _isUnauthorized(http.BaseResponse response) {
    if (response.statusCode != 401 && response.statusCode != 403) return false;
    ApiAuth.reportUnauthorized(machine.id, ApiService.hester);
    return true;
  }

  /// Fetch `GET /health` as a map.
  ///
  /// Includes `auth` ("bearer" or "disabled"), `workspace` — the project the
  /// daemon is currently pointed at — `workspace_id`, `session_backend` and a
  /// `components` block.
  Future<Map<String, dynamic>?> getHealth() async {
    if (_baseUrl == null) return null;
    try {
      final response = await _client
          .get(Uri.parse('$_baseUrl/health'), headers: _headers)
          .timeout(const Duration(seconds: 5));
      if (response.statusCode == 200) {
        return jsonDecode(response.body) as Map<String, dynamic>;
      }
      _isUnauthorized(response);
    } catch (_) {
      // Connection failed
    }
    return null;
  }

  /// Health check. Returns true if Hester daemon is reachable.
  Future<bool> healthCheck() async {
    if (_baseUrl == null) return false;
    try {
      final response = await _client
          .get(
            Uri.parse('$_baseUrl/health'),
            headers: _headers,
          )
          .timeout(const Duration(seconds: 3));
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Send a message to Hester and get a response (synchronous).
  Future<String?> sendMessage(String sessionId, String message) async {
    if (_baseUrl == null) return null;
    try {
      final body = jsonEncode({
        'session_id': sessionId,
        'message': message,
      });
      final response = await _client
          .post(
            Uri.parse('$_baseUrl/context'),
            headers: _headers,
            body: body,
          )
          .timeout(const Duration(seconds: 30));
      _isUnauthorized(response);
      if (response.statusCode == 200) {
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        return json['response'] as String?;
      }
    } catch (_) {
      // Connection failed
    }
    return null;
  }

  /// Stream a message to Hester via SSE (POST /context/stream).
  ///
  /// Returns a [http.StreamedResponse] whose body is an SSE byte stream.
  /// Caller is responsible for parsing SSE events from the stream.
  Future<http.StreamedResponse?> streamMessage(
    String sessionId,
    String message,
  ) async {
    if (_baseUrl == null) return null;
    try {
      final request = http.Request(
        'POST',
        Uri.parse('$_baseUrl/context/stream'),
      );
      request.headers.addAll(_headers);
      request.body = jsonEncode({
        'session_id': sessionId,
        'source': 'Aeronaut',
        'message': message,
      });

      final response = await _client.send(request);
      if (_isUnauthorized(response)) {
        throw const HesterAuthException();
      }
      if (response.statusCode == 200) {
        return response;
      }
    } on HesterAuthException {
      rethrow;
    } catch (_) {
      // Connection failed
    }
    return null;
  }

  /// List all active Hester sessions.
  Future<List<String>> getSessions() async {
    if (_baseUrl == null) return [];
    try {
      final response = await _client
          .get(
            Uri.parse('$_baseUrl/sessions'),
            headers: _headers,
          )
          .timeout(const Duration(seconds: 5));
      _isUnauthorized(response);
      if (response.statusCode == 200) {
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        final sessions = json['sessions'] as List<dynamic>;
        return sessions.map((s) => s as String).toList();
      }
    } catch (_) {
      // Connection failed
    }
    return [];
  }

  /// Get session history (messages) for a specific session.
  Future<List<ChatMessage>> getSessionHistory(String sessionId) async {
    if (_baseUrl == null) return [];
    try {
      final response = await _client
          .get(
            Uri.parse('$_baseUrl/session/$sessionId/history'),
            headers: _headers,
          )
          .timeout(const Duration(seconds: 10));
      _isUnauthorized(response);
      if (response.statusCode == 200) {
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        final history = json['conversation_history'] as List<dynamic>? ?? [];
        return history.map((m) {
          final msg = m as Map<String, dynamic>;
          return ChatMessage.fromJson(msg);
        }).toList();
      }
    } catch (_) {
      // Connection failed
    }
    return [];
  }

  /// Delete a Hester session.
  Future<bool> deleteSession(String sessionId) async {
    if (_baseUrl == null) return false;
    try {
      final response = await _client
          .delete(
            Uri.parse('$_baseUrl/session/$sessionId'),
            headers: _headers,
          )
          .timeout(const Duration(seconds: 5));
      _isUnauthorized(response);
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// List all context bundles.
  Future<List<BundleSummary>> getBundles() async {
    if (_baseUrl == null) return [];
    try {
      final response = await _client
          .get(
            Uri.parse('$_baseUrl/bundles'),
            headers: _headers,
          )
          .timeout(const Duration(seconds: 5));
      _isUnauthorized(response);
      if (response.statusCode == 200) {
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        final bundles = json['bundles'] as List<dynamic>;
        return bundles
            .map((b) => BundleSummary.fromJson(b as Map<String, dynamic>))
            .toList();
      }
    } catch (_) {
      // Connection failed
    }
    return [];
  }

  /// Get the content of a specific context bundle.
  Future<String?> getBundleContent(String bundleId) async {
    if (_baseUrl == null) return null;
    try {
      final response = await _client
          .get(
            Uri.parse('$_baseUrl/bundles/$bundleId'),
            headers: _headers,
          )
          .timeout(const Duration(seconds: 10));
      _isUnauthorized(response);
      if (response.statusCode == 200) {
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        return json['content'] as String?;
      }
    } catch (_) {
      // Connection failed
    }
    return null;
  }

  /// `GET /copilot/digest?workspace=` (contracts §8.4) — verified wins,
  /// agent claims, waiting items and Someday/retro counts since the last
  /// away period. Used by Aeronaut's Wins section (v1). Null on any
  /// failure, including a plain unreachable daemon ("Hester offline").
  Future<DigestResult?> getDigest({required String workspace}) async {
    if (_baseUrl == null) return null;
    try {
      final uri = Uri.parse('$_baseUrl/copilot/digest')
          .replace(queryParameters: {'workspace': workspace});
      final response =
          await _client.get(uri, headers: _headers).timeout(const Duration(seconds: 10));
      _isUnauthorized(response);
      if (response.statusCode == 200) {
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        final data = json['data'];
        if (data is Map<String, dynamic>) return DigestResult.fromJson(data);
      }
    } catch (_) {
      // Connection failed
    }
    return null;
  }

  /// `GET /someday?workspace=&status=` — open Someday items for a
  /// workspace, newest first (the daemon already sorts; contracts' Someday
  /// store). Null on any failure, including a plain unreachable daemon
  /// ("Hester offline"), same convention as [getDigest].
  Future<List<SomedayItem>?> getSomeday({required String workspace, String status = 'open'}) async {
    if (_baseUrl == null) return null;
    try {
      final uri = Uri.parse('$_baseUrl/someday')
          .replace(queryParameters: {'workspace': workspace, 'status': status});
      final response =
          await _client.get(uri, headers: _headers).timeout(const Duration(seconds: 10));
      _isUnauthorized(response);
      if (response.statusCode == 200) {
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        final data = json['data'];
        if (data is List) {
          return data
              .whereType<Map<String, dynamic>>()
              .map(SomedayItem.fromJson)
              .toList();
        }
      }
    } catch (_) {
      // Connection failed
    }
    return null;
  }

  /// `POST /someday/{id}/triage` — explore, promote, drop or keep. Returns
  /// the updated item on success, null on any failure (including a 403 from
  /// a device that isn't allowed to act — [_isUnauthorized] treats 401 and
  /// 403 the same way here, same as every other route on this client).
  Future<SomedayItem?> triageSomeday(String id, {required String workspace, required String action}) async {
    if (_baseUrl == null) return null;
    try {
      final response = await _client
          .post(
            Uri.parse('$_baseUrl/someday/${Uri.encodeComponent(id)}/triage'),
            headers: _headers,
            body: jsonEncode({'workspace': workspace, 'action': action}),
          )
          .timeout(const Duration(seconds: 10));
      _isUnauthorized(response);
      if (response.statusCode == 200) {
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        final data = json['data'];
        if (data is Map<String, dynamic>) return SomedayItem.fromJson(data);
      }
    } catch (_) {
      // Connection failed
    }
    return null;
  }

  void dispose() {
    _client.close();
  }
}
