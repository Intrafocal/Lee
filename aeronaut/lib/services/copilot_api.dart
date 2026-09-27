import 'dart:convert';

import 'package:equatable/equatable.dart';
import 'package:http/http.dart' as http;

import '../models/attention.dart';
import '../models/carry.dart';
import '../models/machine.dart';
import 'api_auth.dart';

/// HTTP client for Lee's Copilot v0/v1 endpoints on the Host API (:9001,
/// contracts §5.6, §9.2): the attention queue, focus, hand-off and capture.
///
/// Same auth model as `LeeApi`/`FsApi`: bearer token, 401 reported through
/// [ApiAuth] so the UI can say "Token rejected. Re-pair this machine."
/// instead of a generic failure.
///
/// Unlike `LeeApi`/`FsApi`, a 403 here is *not* necessarily a rejected
/// token: contracts §4.4 has copilot's write routes (reply/snooze/dismiss/
/// wake/open/focus start-stop/handoff start-end) return 403 for a
/// principal that authenticated fine but isn't allowed to act — a machine
/// still on the legacy shared token, in particular. That must not be
/// treated the same as a bad token: [ApiAuth.reportUnauthorized] tears down
/// the whole machine connection (WS included), which would also kill the
/// read-only Tabs/Files/Waiting views a 403'd write action has no bearing
/// on. Only [_isUnauthorized] (401) reports through [ApiAuth]; a 403 is
/// surfaced as a result-level error via [_reAuthMessage] instead.
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
    if (response.statusCode != 401) return false;
    ApiAuth.reportUnauthorized(machine.id, ApiService.lee);
    return true;
  }

  bool _isForbidden(http.BaseResponse response) => response.statusCode == 403;

  /// Message for a 403 on a write action: the token is fine, but this
  /// device (or the shared token it's using) isn't allowed to act.
  static const _reAuthMessage = 'Re-pair this device to act from here.';

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
    int? choice,
    required int version,
  }) {
    return _postAction('/attention/${Uri.encodeComponent(itemId)}/reply', {
      'action': action,
      if (text != null) 'text': text,
      if (choice != null) 'choice': choice,
      'version': version,
    });
  }

  /// `GET /attention/:id` — one item with its full (up to ~2000 char) text,
  /// for expanding a clipped compact-snapshot item on demand (contracts
  /// §5.6). Null on any non-200 (404/410 "gone", 401, connection failure) —
  /// callers keep showing the clipped text they already have rather than
  /// surfacing an error for what's just a nice-to-have expansion.
  Future<AttentionItem?> getItem(String itemId) async {
    try {
      final uri = Uri.parse('${machine.hostUrl}/attention/${Uri.encodeComponent(itemId)}');
      final response =
          await _client.get(uri, headers: _headers).timeout(const Duration(seconds: 6));
      if (_isUnauthorized(response)) return null;
      if (response.statusCode == 200) {
        final data = _data(response);
        if (data != null) return AttentionItem.fromJson(data);
      }
    } catch (_) {
      // Connection failed
    }
    return null;
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
      if (_isForbidden(response)) {
        return const CaptureResult(success: false, error: _reAuthMessage);
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
      if (_isForbidden(response)) {
        return const HandoffResult(success: false, error: _reAuthMessage);
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

  /// The body's `data` map (Lee's envelope), or the body itself when a route
  /// answers without the envelope.
  Map<String, dynamic>? _dataOrBody(http.Response response) {
    try {
      final json = jsonDecode(response.body);
      if (json is! Map<String, dynamic>) return null;
      final data = json['data'];
      return data is Map<String, dynamic> ? data : json;
    } catch (_) {
      return null;
    }
  }

  /// `GET /carry?workspace=` — Library's Carry (docs/14-Deep-Work.md §8.1):
  /// your last Desk card, its open questions and what the Mac opens
  /// next. Without [workspace] Lee uses the focused window's. A 503 means
  /// Hester is offline.
  Future<CarryResult> getCarry({String? workspace}) async {
    try {
      final uri = Uri.parse('${machine.hostUrl}/carry').replace(
        queryParameters: workspace != null ? {'workspace': workspace} : null,
      );
      final response = await _client.get(uri, headers: _headers).timeout(const Duration(seconds: 8));
      if (_isUnauthorized(response)) {
        return const CarryResult(error: 'Token rejected. Re-pair this machine.');
      }
      if (_isForbidden(response)) return const CarryResult(error: _reAuthMessage);
      if (response.statusCode == 503) return const CarryResult(error: 'hester_offline');
      final data = _dataOrBody(response);
      if (response.statusCode == 200 && data != null) {
        return CarryResult(carry: CarrySnapshot.fromJson(data));
      }
      if (response.statusCode == 404) {
        return const CarryResult(error: 'This Lee is too old for Carry. Update Lee on the Mac.');
      }
      return CarryResult(error: _errorMessage(response) ?? 'HTTP ${response.statusCode}');
    } catch (_) {
      return const CarryResult(error: 'Could not reach Lee.');
    }
  }

  /// `POST /carry/capture` — a thought captured away from the Mac, into
  /// the card [cardId] when given. Lands in the opener's "Captured away".
  /// With Hester offline, Lee spools it and answers `spooled: true`.
  Future<CaptureResult> carryCapture(String text, {String? workspace, String? cardId}) async {
    return _postCarry('/carry/capture', {
      'text': text,
      if (workspace != null) 'workspace': workspace,
      if (cardId != null) 'card_id': cardId,
    }, (data) => CaptureResult.fromJson({'success': true, ...data}));
  }

  /// `POST /carry/open-next` — what the Mac's next Deep session opens first
  /// (a card or a captured thought).
  Future<CaptureResult> carryOpenNext({String? workspace, String? cardId, String? somedayId}) async {
    return _postCarry('/carry/open-next', {
      if (workspace != null) 'workspace': workspace,
      if (cardId != null) 'card_id': cardId,
      if (somedayId != null) 'someday_id': somedayId,
    }, (_) => const CaptureResult(success: true));
  }

  /// `POST /command {domain: tab, action: checkin, params: {pty_id}}`: ask a
  /// running agent where it is; its answer arrives as its words. 202 means
  /// this token may only propose it and Lee asks at the desk.
  Future<ActionResult> agentCheckin(int ptyId) async {
    try {
      final response = await _client
          .post(
            Uri.parse('${machine.hostUrl}/command'),
            headers: _headers,
            body: jsonEncode({'domain': 'tab', 'action': 'checkin', 'params': {'pty_id': ptyId}}),
          )
          .timeout(const Duration(seconds: 8));
      if (_isUnauthorized(response)) {
        return const ActionResult(success: false, error: 'Token rejected. Re-pair this machine.');
      }
      if (_isForbidden(response)) return const ActionResult(success: false, error: _reAuthMessage);
      if (response.statusCode == 202) return const ActionResult(success: true, error: 'proposed');
      if (response.statusCode == 200) return const ActionResult(success: true);
      return ActionResult(success: false, error: _errorMessage(response) ?? 'HTTP ${response.statusCode}');
    } catch (e) {
      return ActionResult(success: false, error: e.toString());
    }
  }

  /// `POST /deep/idle-end` (Desk D2 §9.2): answer the "Still thinking?"
  /// push. [action] is `extend` or `end_rate`; [rating] is `deep`, `mixed`,
  /// `shallow` or null. A 409 (the push was answered or the session moved
  /// on) comes back as error 'stale'.
  Future<ActionResult> deepIdleEnd(
    String itemId, {
    required int version,
    required String action,
    String? rating,
    String? stoppedAt,
  }) async {
    try {
      final response = await _client
          .post(
            Uri.parse('${machine.hostUrl}/deep/idle-end'),
            headers: _headers,
            body: jsonEncode({
              'item_id': itemId,
              'version': version,
              'action': action,
              if (action == 'end_rate') 'rating': rating,
              if (stoppedAt != null && stoppedAt.trim().isNotEmpty) 'stopped_at': stoppedAt.trim(),
            }),
          )
          .timeout(const Duration(seconds: 8));
      if (_isUnauthorized(response)) {
        return const ActionResult(success: false, error: 'Token rejected. Re-pair this machine.');
      }
      if (_isForbidden(response)) return const ActionResult(success: false, error: _reAuthMessage);
      if (response.statusCode == 200) return const ActionResult(success: true);
      if (response.statusCode == 409) return const ActionResult(success: false, error: 'stale');
      if (response.statusCode == 404) return const ActionResult(success: false, error: 'gone');
      return ActionResult(success: false, error: _errorMessage(response) ?? 'HTTP ${response.statusCode}');
    } catch (e) {
      return ActionResult(success: false, error: e.toString());
    }
  }

  Future<CaptureResult> _postCarry(
    String path,
    Map<String, dynamic> body,
    CaptureResult Function(Map<String, dynamic> data) onOk,
  ) async {
    try {
      final response = await _client
          .post(Uri.parse('${machine.hostUrl}$path'), headers: _headers, body: jsonEncode(body))
          .timeout(const Duration(seconds: 10));
      if (_isUnauthorized(response)) {
        return const CaptureResult(success: false, error: 'Token rejected. Re-pair this machine.');
      }
      if (_isForbidden(response)) return const CaptureResult(success: false, error: _reAuthMessage);
      if (response.statusCode == 503) return const CaptureResult(success: false, error: 'Hester is offline.');
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return onOk(_dataOrBody(response) ?? const {});
      }
      return CaptureResult(success: false, error: _errorMessage(response) ?? 'HTTP ${response.statusCode}');
    } catch (e) {
      return CaptureResult(success: false, error: e.toString());
    }
  }

  Future<ActionResult> _postAction(String path, Map<String, dynamic> body) async {
    try {
      final response = await _client
          .post(Uri.parse('${machine.hostUrl}$path'), headers: _headers, body: jsonEncode(body))
          .timeout(const Duration(seconds: 8));
      if (_isUnauthorized(response)) {
        return const ActionResult(success: false, error: 'Token rejected. Re-pair this machine.');
      }
      if (_isForbidden(response)) {
        return const ActionResult(success: false, error: _reAuthMessage);
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
