import 'dart:convert';

import 'package:equatable/equatable.dart';
import 'package:http/http.dart' as http;

import '../models/lee_context.dart';
import '../models/machine.dart';

/// Info about an open Lee window (workspace).
class WindowInfo extends Equatable {
  final int id;
  final String? workspace;
  final bool focused;

  const WindowInfo({
    required this.id,
    this.workspace,
    this.focused = false,
  });

  /// Workspace name (last path segment), or "Untitled" if no workspace.
  String get workspaceName {
    if (workspace == null || workspace!.isEmpty) return 'Untitled';
    return workspace!.split('/').last;
  }

  factory WindowInfo.fromJson(Map<String, dynamic> json) {
    return WindowInfo(
      id: (json['id'] as num).toInt(),
      workspace: json['workspace'] as String?,
      focused: json['focused'] as bool? ?? false,
    );
  }

  @override
  List<Object?> get props => [id, workspace, focused];
}

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

  /// Fetch the list of open windows (workspaces) on this host.
  Future<List<WindowInfo>> getWindows() async {
    try {
      final response = await _client
          .get(
            Uri.parse('${machine.hostUrl}/windows'),
            headers: _headers,
          )
          .timeout(const Duration(seconds: 3));
      if (response.statusCode == 200) {
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        final data = json['data'] as List<dynamic>? ?? [];
        return data
            .map((w) => WindowInfo.fromJson(w as Map<String, dynamic>))
            .toList();
      }
    } catch (_) {
      // Connection failed
    }
    return [];
  }

  /// Send a command to the Lee Host.
  ///
  /// If [windowId] is provided, the command targets that specific window.
  ///
  /// Example:
  /// ```dart
  /// await api.sendCommand('system', 'focus_tab', {'tab_id': 2}, windowId: 3);
  /// ```
  Future<bool> sendCommand(
    String domain,
    String action, [
    Map<String, dynamic>? params,
    int? windowId,
  ]) async {
    try {
      final mergedParams = <String, dynamic>{
        if (params != null) ...params,
        if (windowId != null) 'window_id': windowId,
      };
      final body = jsonEncode({
        'domain': domain,
        'action': action,
        if (mergedParams.isNotEmpty) 'params': mergedParams,
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
