import 'dart:convert';

import 'package:equatable/equatable.dart';
import 'package:http/http.dart' as http;

import '../models/attention.dart';
import '../models/machine.dart';
import 'api_auth.dart';

/// HTTP client for Lee's Copilot v0/v1 endpoints on the Host API (:9001,
/// contracts §5.6, §9.2): the attention queue, focus, hand-off and capture.
///
/// Same auth model as `LeeApi`/`FsApi`: bearer token, 401 reported through
/// [ApiAuth] so the UI can say "Token rejected. Re-pair this machine."
/// instead of a generic failure.
class CopilotApi {
  final Machine machine;
  final http.Client _client;

  CopilotApi({required this.machine, http.Client? client})
      : _client = client ?? http.Client();

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (machine.token.isNotEmpty)
          'Authorization': 'Bearer ${machine.token}',
      };

  bool _isUnauthorized(http.BaseResponse response) {
    if (response.statusCode != 401 && response.statusCode != 403) return false;
    ApiAuth.reportUnauthorized(machine.id, ApiService.lee);
    return true;
  }

  /// Unwrap the `{ "success": true, "data": … }` envelope every Lee route
  /// on :9001 uses. Returns null on a non-map body or bad JSON.
  Map<String, dynamic>? _data(http.Response response) {
    try {
      final json = jsonDecode(response.body) as Map<String, dynamic>;
      final data = json['data'];
      return data is Map<String, dynamic> ? data : null;
    } catch (_) {
      return null;
    }
  }

  String? _errorMessage(http.Response response) {
    try {
      final json = jsonDecode(response.body) as Map<String, dynamic>;
      return json['error'] as String?;
    } catch (_) {
      return null;
    }
  }

  /// `GET /attention?compact=1` — the live queue. Compact by default: it's
  /// what the WS `attention_snapshot` pushes carry too (contracts §5.6).
  Future<AttentionSnapshot?> getSnapshot({bool compact = true}) async {
    try {
      final uri = Uri.parse('${machine.hostUrl}/attention').replace(
        queryParameters: compact ? const {'compact': '1'} : null,
      );
      final response =
          await _client.get(uri, headers: _headers).timeout(const Duration(seconds: 6));
      if (_isUnauthorized(response)) return null;
      if (response.statusCode == 200) {
        final data = _data(response);
        if (data != null) return AttentionSnapshot.fromJson(data);
      }
    } catch (_) {
      // Connection failed
    }
    return null;
  }

  Future<ActionResult> reply(
    String itemId, {
    required String action,
    String? text,
    required int version,
  }) {
    return _postAction('/attention/${Uri.encodeComponent(itemId)}/reply', {
      'action': action,
      if (text != null) 'text': text,
      'version': version,
    });
  }

  Future<ActionResult> snooze(String itemId, {String? until, int? minutes}) {
    return _postAction('/attention/${Uri.encodeComponent(itemId)}/snooze', {
      if (until != null) 'until': until,
      if (minutes != null) 'minutes': minutes,
    });
  }

  Future<ActionResult> dismiss(String itemId) =>
      _postAction('/attention/${Uri.encodeComponent(itemId)}/dismiss', const {});

  Future<ActionResult> setWake(String itemId, bool wake) =>
      _postAction('/attention/${Uri.encodeComponent(itemId)}/wake', {'wake': wake});

  Future<ActionResult> open(String itemId) =>
      _postAction('/attention/${Uri.encodeComponent(itemId)}/open', const {});

  Future<CaptureResult> capture(
    String text, {
    String? workspace,
    bool asExploration = false,
  }) async {
    try {
      final body = jsonEncode({
        'text': text,
        if (workspace != null) 'workspace': workspace,
        'as': asExploration ? 'explore' : 'someday',
      });
      final response = await _client
          .post(Uri.parse('${machine.hostUrl}/capture'), headers: _headers, body: body)
          .timeout(const Duration(seconds: 10));
      if (_isUnauthorized(response)) {
        return const CaptureResult(success: false, error: 'Token rejected. Re-pair this machine.');
      }
      final data = _data(response);
      if (response.statusCode == 200 && data != null) {
        return CaptureResult.fromJson(data);
      }
      return CaptureResult(success: false, error: _errorMessage(response) ?? 'HTTP ${response.statusCode}');
    } catch (e) {
      return CaptureResult(success: false, error: e.toString());
    }
  }

  Future<FocusState?> getFocus() async {
    try {
      final response = await _client
          .get(Uri.parse('${machine.hostUrl}/focus'), headers: _headers)
          .timeout(const Duration(seconds: 5));
      if (_isUnauthorized(response)) return null;
      if (response.statusCode == 200) {
        final data = _data(response);
        if (data != null) return FocusState.fromJson(data);
      }
    } catch (_) {
      // Connection failed
    }
    return null;
  }

  Future<FocusState?> focusStart({FocusItem? item}) async {
    try {
      final body = jsonEncode({if (item != null) 'item': item.toJson()});
      final response = await _client
          .post(Uri.parse('${machine.hostUrl}/focus/start'), headers: _headers, body: body)
          .timeout(const Duration(seconds: 8));
      if (_isUnauthorized(response)) return null;
      if (response.statusCode == 200) {
        final data = _data(response);
        if (data != null) return FocusState.fromJson(data);
      }
    } catch (_) {
      // Connection failed
    }
    return null;
  }

  Future<FocusState?> focusStop() async {
    try {
      final response = await _client
          .post(Uri.parse('${machine.hostUrl}/focus/stop'), headers: _headers)
          .timeout(const Duration(seconds: 8));
      if (_isUnauthorized(response)) return null;
      if (response.statusCode == 200) {
        final data = _data(response);
        if (data != null) return FocusState.fromJson(data);
      }
    } catch (_) {
      // Connection failed
    }
    return null;
  }

  Future<HandoffProposals?> handoffProposals() async {
    try {
      final response = await _client
          .get(Uri.parse('${machine.hostUrl}/handoff/proposals'), headers: _headers)
          .timeout(const Duration(seconds: 8));
      if (_isUnauthorized(response)) return null;
      if (response.statusCode == 200) {
        final data = _data(response);
        if (data != null) return HandoffProposals.fromJson(data);
      }
    } catch (_) {
      // Connection failed
    }
    return null;
  }

  Future<HandoffResult> handoffStart(HandoffRequest request) async {
    try {
      final response = await _client
          .post(
            Uri.parse('${machine.hostUrl}/handoff/start'),
            headers: _headers,
            body: jsonEncode(request.toJson()),
          )
          .timeout(const Duration(seconds: 10));
      if (_isUnauthorized(response)) {
        return const HandoffResult(success: false, error: 'Token rejected. Re-pair this machine.');
      }
      final data = _data(response);
      if (response.statusCode == 200 && data != null) {
        return HandoffResult.fromJson(data);
      }
      return HandoffResult(success: false, error: _errorMessage(response) ?? 'HTTP ${response.statusCode}');
    } catch (e) {
      return HandoffResult(success: false, error: e.toString());
    }
  }

  Future<AwayState?> handoffEnd() async {
    try {
      final response = await _client
          .post(Uri.parse('${machine.hostUrl}/handoff/end'), headers: _headers)
          .timeout(const Duration(seconds: 8));
      if (_isUnauthorized(response)) return null;
      if (response.statusCode == 200) {
        final data = _data(response);
        if (data != null) return AwayState.fromJson(data);
      }
    } catch (_) {
      // Connection failed
    }
    return null;
  }

  Future<ActionResult> _postAction(String path, Map<String, dynamic> body) async {
    try {
      final response = await _client
          .post(Uri.parse('${machine.hostUrl}$path'), headers: _headers, body: jsonEncode(body))
          .timeout(const Duration(seconds: 8));
      if (_isUnauthorized(response)) {
        return const ActionResult(success: false, error: 'Token rejected. Re-pair this machine.');
      }
      if (response.statusCode == 200) {
        final data = _data(response);
        if (data != null) return ActionResult.fromJson(data);
        return const ActionResult(success: true);
      }
      if (response.statusCode == 409) {
        return const ActionResult(success: false, error: 'stale');
      }
      if (response.statusCode == 410) {
        return const ActionResult(success: false, error: 'gone');
      }
      return ActionResult(success: false, error: _errorMessage(response) ?? 'HTTP ${response.statusCode}');
    } catch (e) {
      return ActionResult(success: false, error: e.toString());
    }
  }

  void dispose() {
    _client.close();
  }
}

/// Outcome of `POST /pair/redeem` (contracts §4.2). Unlike every other route
/// here, it needs no bearer token — the point of a ticket is that the QR
/// itself never carries one.
class PairRedeemResult extends Equatable {
  final String status; // approved | expired | error
  final String? token;
  final String? deviceId;
  final int? hesterPort;
  final String? name;
  final String? error;

  const PairRedeemResult({
    required this.status,
    this.token,
    this.deviceId,
    this.hesterPort,
    this.name,
    this.error,
  });

  bool get isApproved => status == 'approved' && token != null && token!.isNotEmpty;
  bool get isExpired => status == 'expired';

  @override
  List<Object?> get props => [status, token, deviceId, hesterPort, name, error];
}

/// Redeems a v2 pairing ticket. Unauthenticated on the wire (contracts
/// §4.2), so it's constructed from host/port directly rather than a
/// [Machine] that doesn't have a token yet.
class PairingApi {
  final String host;
  final int hostPort;
  final http.Client _client;

  PairingApi({required this.host, required this.hostPort, http.Client? client})
      : _client = client ?? http.Client();

  Future<PairRedeemResult> redeem({
    required String ticket,
    required String device,
    required String kind,
  }) async {
    try {
      final response = await _client
          .post(
            Uri.parse('http://$host:$hostPort/pair/redeem'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({'ticket': ticket, 'device': device, 'kind': kind}),
          )
          .timeout(const Duration(seconds: 8));

      Map<String, dynamic> body = const {};
      try {
        body = jsonDecode(response.body) as Map<String, dynamic>;
      } catch (_) {
        // Some error statuses (e.g. a plain 400) may not carry JSON.
      }

      if (response.statusCode == 200) {
        return PairRedeemResult(
          status: body['status'] as String? ?? 'approved',
          token: body['token'] as String?,
          deviceId: body['device_id'] as String?,
          hesterPort: (body['hester_port'] as num?)?.toInt(),
          name: body['name'] as String?,
        );
      }
      if (response.statusCode == 410) {
        return const PairRedeemResult(status: 'expired');
      }
      return PairRedeemResult(
        status: 'error',
        error: body['error'] as String? ?? 'HTTP ${response.statusCode}',
      );
    } catch (e) {
      return PairRedeemResult(status: 'error', error: e.toString());
    }
  }

  void dispose() {
    _client.close();
  }
}
