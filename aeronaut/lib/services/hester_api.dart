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

  // -------------------------------------------------------------------------
  // Tasks, for the one-agent screen's Rename / Accept / Assign (Desk D2 §9.4).
  // Straight to Hester: Lee main has no task routes of its own.
  // -------------------------------------------------------------------------

  /// `GET /cockpit/tasks?workspace=&status=open`. Null on any failure.
  Future<List<TaskRef>?> getOpenTasks({required String workspace}) async {
    if (_baseUrl == null) return null;
    try {
      final uri = Uri.parse('$_baseUrl/cockpit/tasks')
          .replace(queryParameters: {'workspace': workspace, 'status': 'open'});
      final response = await _client.get(uri, headers: _headers).timeout(const Duration(seconds: 10));
      _isUnauthorized(response);
      if (response.statusCode == 200) {
        final data = (jsonDecode(response.body) as Map<String, dynamic>)['data'];
        if (data is List) {
          return data.whereType<Map<String, dynamic>>().map(TaskRef.fromJson).where((t) => t.id.isNotEmpty).toList();
        }
      }
    } catch (_) {
      // Connection failed
    }
    return null;
  }

  /// `POST /cockpit/tasks/name`: your name for a task, by task id or, for
  /// an agent with no task, its session id. Null on success, else why not.
  Future<String?> renameTask({required String workspace, String? taskId, String? sessionId, required String name}) =>
      _post('/cockpit/tasks/name', {
        'workspace': workspace,
        if (taskId != null) 'task_id': taskId,
        if (sessionId != null) 'session_id': sessionId,
        'name': name,
        'source': 'user',
      });

  /// `POST /cockpit/tasks/{id}/close {status: done, accepted: true}`: Accept
  /// a task in review, as the Mac's Work does.
  Future<String?> acceptTask({required String workspace, required String taskId}) =>
      _post('/cockpit/tasks/${Uri.encodeComponent(taskId)}/close', {'workspace': workspace, 'status': 'done', 'accepted': true});

  /// `POST /cockpit/tasks/{id}/link`: attach an agent with no task to an open one.
  Future<String?> linkTask({
    required String workspace,
    required String taskId,
    required int ptyId,
    String? sessionId,
    required String provider,
    required String tabLabel,
  }) =>
      _post('/cockpit/tasks/${Uri.encodeComponent(taskId)}/link', {
        'workspace': workspace,
        'pty_id': ptyId,
        if (sessionId != null) 'session_id': sessionId,
        'provider': provider,
        'tab_label': tabLabel,
      });

  /// `POST /cockpit/tasks`: a new task from an agent with none (the Mac's
  /// Assign… "New task").
  Future<String?> createTaskForAgent({
    required String workspace,
    required String title,
    required int ptyId,
    String? sessionId,
    required String provider,
    required String tabLabel,
  }) =>
      _post('/cockpit/tasks', {
        'workspace': workspace,
        'title': title,
        'title_source': 'user',
        'status': 'running',
        'agent': {'provider': provider, 'pty_id': ptyId, 'session_id': sessionId, 'tab_label': tabLabel},
        'confirmed': true,
        'origin': {'kind': 'agent'},
      });

  Future<String?> _post(String path, Map<String, dynamic> body) async {
    if (_baseUrl == null) return 'Hester is not set up for this machine.';
    try {
      final response = await _client
          .post(Uri.parse('$_baseUrl$path'), headers: _headers, body: jsonEncode(body))
          .timeout(const Duration(seconds: 10));
      if (_isUnauthorized(response)) return 'Re-pair this device to act from here.';
      if (response.statusCode >= 200 && response.statusCode < 300) return null;
      try {
        final error = (jsonDecode(response.body) as Map<String, dynamic>)['error'];
        if (error is String && error.isNotEmpty) return error;
      } catch (_) {
        // not JSON
      }
      return 'Hester returned ${response.statusCode}';
    } catch (_) {
      return 'Hester is offline.';
    }
  }

  void dispose() {
    _client.close();
  }
}
