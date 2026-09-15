import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/fs_entry.dart';
import '../models/machine.dart';
import 'api_auth.dart';

/// Why an `/fs/*` request didn't return content.
enum FsErrorKind {
  /// 403 — path resolves outside every open window's workspace.
  forbidden,

  /// 404 — path doesn't exist.
  notFound,

  /// 413 — file is over the 2 MB read cap. `result` still carries metadata.
  tooLarge,

  /// 415 — binary file type Lee's endpoint won't base64 for viewing.
  /// `result` still carries metadata.
  unviewable,

  /// 401 — token rejected (also reported to [ApiAuth]).
  unauthorized,

  /// Network failure, bad JSON, unreachable host, etc.
  network,

  /// Any other non-200 the server returned.
  other,
}

/// Thrown by [FsApi] methods on any non-200 response. Carries the decoded
/// metadata when the server sent one alongside the error (413/415 always
/// do), so callers can still show path/size/mtime.
class FsApiException implements Exception {
  final FsErrorKind kind;
  final String message;
  final FsReadResult? result;

  const FsApiException(this.kind, this.message, {this.result});

  @override
  String toString() => 'FsApiException($kind: $message)';
}

/// HTTP client for Lee's read-only filesystem endpoints
/// (`GET /fs/read`, `GET /fs/list`), added alongside the file viewer and
/// files browser. Same auth model as [LeeApi]: bearer token, 401 reported
/// through [ApiAuth].
class FsApi {
  final Machine machine;
  final http.Client _client;

  FsApi({required this.machine, http.Client? client})
      : _client = client ?? http.Client();

  Map<String, String> get _headers => {
        if (machine.token.isNotEmpty)
          'Authorization': 'Bearer ${machine.token}',
      };

  /// Read a file's content. Pass [statOnly] to fetch only metadata (no size
  /// cap applies, no content returned) — useful for pdf/binary/kicad/model
  /// tabs that just want to show "N bytes" without downloading them.
  Future<FsReadResult> readFile(String path, {bool statOnly = false}) async {
    final uri = Uri.parse('${machine.hostUrl}/fs/read').replace(
      queryParameters: {
        'path': path,
        if (statOnly) 'stat': '1',
      },
    );
    late final http.Response response;
    try {
      response = await _client
          .get(uri, headers: _headers)
          .timeout(const Duration(seconds: 10));
    } catch (e) {
      throw FsApiException(FsErrorKind.network, e.toString());
    }

    Map<String, dynamic>? body;
    try {
      body = jsonDecode(response.body) as Map<String, dynamic>;
    } catch (_) {
      // Fall through — some error statuses may not carry a JSON body.
    }

    if (response.statusCode == 200) {
      final data = body?['data'] as Map<String, dynamic>? ?? {};
      return FsReadResult.fromJson(data);
    }

    final data = body?['data'] as Map<String, dynamic>?;
    final partial = data != null ? FsReadResult.fromJson(data) : null;
    final message = body?['error'] as String? ?? 'HTTP ${response.statusCode}';

    switch (response.statusCode) {
      case 401:
        ApiAuth.reportUnauthorized(machine.id, ApiService.lee);
        throw FsApiException(FsErrorKind.unauthorized, message);
      case 403:
        throw FsApiException(FsErrorKind.forbidden, message);
      case 404:
        throw FsApiException(FsErrorKind.notFound, message);
      case 413:
        throw FsApiException(FsErrorKind.tooLarge, message, result: partial);
      case 415:
        throw FsApiException(FsErrorKind.unviewable, message, result: partial);
      default:
        throw FsApiException(FsErrorKind.other, message);
    }
  }

  /// List a directory. [path] defaults to the focused window's workspace
  /// when omitted (Lee's side fills that in).
  Future<FsListResult> listDir([String? path]) async {
    final uri = Uri.parse('${machine.hostUrl}/fs/list').replace(
      queryParameters: {
        if (path != null && path.isNotEmpty) 'path': path,
      },
    );
    late final http.Response response;
    try {
      response = await _client
          .get(uri, headers: _headers)
          .timeout(const Duration(seconds: 10));
    } catch (e) {
      throw FsApiException(FsErrorKind.network, e.toString());
    }

    Map<String, dynamic>? body;
    try {
      body = jsonDecode(response.body) as Map<String, dynamic>;
    } catch (_) {
      // Fall through.
    }

    if (response.statusCode == 200) {
      final data = body?['data'] as Map<String, dynamic>? ?? {};
      return FsListResult.fromJson(data);
    }

    final message = body?['error'] as String? ?? 'HTTP ${response.statusCode}';
    switch (response.statusCode) {
      case 401:
        ApiAuth.reportUnauthorized(machine.id, ApiService.lee);
        throw FsApiException(FsErrorKind.unauthorized, message);
      case 403:
        throw FsApiException(FsErrorKind.forbidden, message);
      case 404:
        throw FsApiException(FsErrorKind.notFound, message);
      default:
        throw FsApiException(FsErrorKind.other, message);
    }
  }

  void dispose() {
    _client.close();
  }
}
