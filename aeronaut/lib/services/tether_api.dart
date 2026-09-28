import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../models/attention.dart' show CaptureResult;
import '../models/machine.dart';
import '../models/send_to_lee.dart';
import '../models/tether.dart';
import 'api_auth.dart';

/// HTTP client for Lee main's `/tether/*` routes on :9001
/// (docs/plans/2026-09-28-tether-review-voice.md §3.3, §4.2): Work's Pick
/// up, capture, Review's Desk / Page / Board / Drawer, and Send to Lee.
///
/// Same auth model as `CopilotApi`: a 401 goes through [ApiAuth]; a 403 is a
/// device that may read but not act, reported as a result-level error.
/// Lee answers 503 `hester_offline` when Hester doesn't (capture spools
/// instead).
class TetherApi {
  final Machine machine;
  final http.Client _client;

  TetherApi({required this.machine, http.Client? client}) : _client = client ?? http.Client();

  static const _rejected = 'Token rejected. Re-pair this machine.';
  static const _reAuth = 'Re-pair this device to act from here.';
  static const _tooOld = 'This Lee is too old for this. Update Lee on the Mac.';

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (machine.token.isNotEmpty) 'Authorization': 'Bearer ${machine.token}',
      };

  /// Headers for an image fetched straight from Lee (a Page's assets).
  Map<String, String> get authHeaders => {
        if (machine.token.isNotEmpty) 'Authorization': 'Bearer ${machine.token}',
      };

  bool _isUnauthorized(http.BaseResponse response) {
    if (response.statusCode != 401) return false;
    ApiAuth.reportUnauthorized(machine.id, ApiService.lee);
    return true;
  }

  /// Lee's `{success, data}` envelope unwrapped, or the body itself when a
  /// route answers without one.
  static dynamic _payload(http.Response response) {
    try {
      final json = jsonDecode(response.body);
      if (json is Map<String, dynamic> && json.containsKey('success') && json.containsKey('data')) return json['data'];
      return json;
    } catch (_) {
      return null;
    }
  }

  static String? _errorOf(http.Response response) {
    try {
      final json = jsonDecode(response.body);
      if (json is Map<String, dynamic>) return json['error'] as String?;
    } catch (_) {
      // not JSON
    }
    return null;
  }

  Uri _uri(String path, [Map<String, String>? query]) {
    final q = {...?query}..removeWhere((_, v) => v.isEmpty);
    return Uri.parse('${machine.hostUrl}$path').replace(queryParameters: q.isEmpty ? null : q);
  }

  /// One GET, mapped to a value or a reason.
  Future<TetherRead<T>> _read<T>(Uri uri, T? Function(dynamic payload) parse) async {
    try {
      final response = await _client.get(uri, headers: _headers).timeout(const Duration(seconds: 8));
      if (_isUnauthorized(response)) return const TetherRead.failed(_rejected);
      if (response.statusCode == 403) return const TetherRead.failed(_reAuth);
      if (response.statusCode == 503) return TetherRead.failed(_errorOf(response) ?? 'hester_offline');
      if (response.statusCode == 404 && _errorOf(response) == null) return const TetherRead.failed(_tooOld);
      if (response.statusCode == 200) {
        final value = parse(_payload(response));
        if (value != null) return TetherRead.ok(value);
      }
      return TetherRead.failed(_errorOf(response) ?? 'HTTP ${response.statusCode}');
    } catch (_) {
      return const TetherRead.failed('Could not reach Lee.');
    }
  }

  /// `GET /tether`: Work's Pick up. Without [workspace] Lee uses the focused window's.
  Future<TetherResult> getTether({String? workspace}) async {
    final read = await _read(_uri('/tether', {'workspace': workspace ?? ''}),
        (p) => p is Map<String, dynamic> ? Tether.fromJson(p) : null);
    return TetherResult(tether: read.value, error: read.error);
  }

  /// `GET /tether/desk`: the Areas on the Desk and their Pages.
  Future<TetherRead<TetherDesk>> getDesk({String? workspace}) =>
      _read(_uri('/tether/desk', {'workspace': workspace ?? ''}),
          (p) => p is Map<String, dynamic> ? TetherDesk.fromJson(p) : null);

  /// `GET /tether/pages`: every Page, stashed ones too, newest first.
  Future<TetherRead<List<TetherCard>>> getPages({String? workspace, int limit = 50}) =>
      _read(_uri('/tether/pages', {'workspace': workspace ?? '', 'limit': '$limit'}),
          (p) => p is List ? p.whereType<Map<String, dynamic>>().map(TetherCard.fromJson).toList() : null);

  /// `GET /tether/pages/:id`: a Page's text and what hangs off it.
  Future<TetherRead<TetherPage>> getPage(String id, {String? workspace}) =>
      _read(_uri('/tether/pages/${Uri.encodeComponent(id)}', {'workspace': workspace ?? ''}),
          (p) => p is Map<String, dynamic> ? TetherPage.fromJson(p) : null);

  /// `GET /tether/boards/:id`: a Board's notes, links, asks and hand-offs.
  Future<TetherRead<TetherBoard>> getBoard(String id, {String? workspace}) =>
      _read(_uri('/tether/boards/${Uri.encodeComponent(id)}', {'workspace': workspace ?? ''}),
          (p) => p is Map<String, dynamic> ? TetherBoard.fromJson(p) : null);

  /// Where a Board's picture lives: `GET /tether/boards/:id/preview` (PNG;
  /// [fetchAsset] gives null on its 404 when there is none).
  Uri boardPreviewUri(String id, {String? workspace}) =>
      _uri('/tether/boards/${Uri.encodeComponent(id)}/preview', {'workspace': workspace ?? ''});

  /// `GET /tether/drawer`: Stashed Areas and Ideas.
  Future<TetherRead<TetherDrawer>> getDrawer({String? workspace}) =>
      _read(_uri('/tether/drawer', {'workspace': workspace ?? ''}),
          (p) => p is Map<String, dynamic> ? TetherDrawer.fromJson(p) : null);

  /// `GET /tether/targets`: Lee's focus and every other place a send can go.
  Future<TetherRead<SendTargets>> getTargets({String? workspace}) =>
      _read(_uri('/tether/targets', {'workspace': workspace ?? ''}),
          (p) => p is Map<String, dynamic> ? SendTargets.fromJson(p) : null);

  /// Where a Page's image lives: `GET /tether/pages/:id/assets/:name`
  /// (Lee proxies Hester, same auth). [src] is the markdown's
  /// `assets/<name>`; anything else is not a Page asset and gives null.
  Uri? assetUri(String pageId, String src, {String? workspace}) {
    if (!src.startsWith('assets/')) return null;
    final name = src.substring('assets/'.length);
    if (name.isEmpty || name.contains('/') || name.contains('..')) return null;
    return _uri('/tether/pages/${Uri.encodeComponent(pageId)}/assets/${Uri.encodeComponent(name)}',
        {'workspace': workspace ?? ''});
  }

  /// The bytes of a Page's image, or null.
  Future<Uint8List?> fetchAsset(Uri uri) async {
    try {
      final response = await _client.get(uri, headers: authHeaders).timeout(const Duration(seconds: 15));
      if (_isUnauthorized(response)) return null;
      return response.statusCode == 200 ? response.bodyBytes : null;
    } catch (_) {
      return null;
    }
  }

  /// `POST /tether/capture`: a thought for Ideas, into the card [cardId]
  /// when given. With Hester offline Lee spools it (`spooled: true`).
  /// [voice] tags a transcript (`input: 'voice'`).
  Future<CaptureResult> capture(String text, {String? workspace, String? cardId, bool voice = false}) async {
    try {
      final response = await _client
          .post(
            _uri('/tether/capture'),
            headers: _headers,
            body: jsonEncode({
              'text': text,
              if (workspace != null) 'workspace': workspace,
              if (cardId != null) 'card_id': cardId,
              if (voice) 'input': 'voice',
            }),
          )
          .timeout(const Duration(seconds: 10));
      if (_isUnauthorized(response)) return const CaptureResult(success: false, error: _rejected);
      if (response.statusCode == 403) return const CaptureResult(success: false, error: _reAuth);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        final p = _payload(response);
        return CaptureResult.fromJson({'success': true, if (p is Map<String, dynamic>) ...p});
      }
      return CaptureResult(success: false, error: _errorOf(response) ?? 'HTTP ${response.statusCode}');
    } catch (e) {
      return const CaptureResult(success: false, error: 'Could not reach Lee.');
    }
  }

  /// `POST /tether/send`: Deliver ([SendRequest.submit] false) or Send.
  /// Waits for Lee's window to answer (Lee gives up after 10 s).
  Future<SendResult> send(SendRequest request) async {
    try {
      final response = await _client
          .post(_uri('/tether/send'), headers: _headers, body: jsonEncode(request.toJson()))
          .timeout(const Duration(seconds: 30));
      if (_isUnauthorized(response)) return const SendResult(error: _rejected);
      if (response.statusCode == 403) return const SendResult(error: _reAuth);
      if (response.statusCode == 200) {
        final p = _payload(response);
        if (p is Map<String, dynamic>) return SendResult.fromJson(p);
        return const SendResult();
      }
      return SendResult(error: sendErrorMessage(response.statusCode, _errorOf(response)));
    } catch (_) {
      return const SendResult(error: 'Could not reach Lee.');
    }
  }

  void dispose() {
    _client.close();
  }
}

/// What a failed send says (§4.2's statuses).
String sendErrorMessage(int status, String? error) {
  if (error == 'no_target') return 'Nothing in front of you on the Mac takes this. Pick where it goes.';
  if (error == 'no_window') return 'Lee has no window open on that workspace.';
  return switch (status) {
    404 => TetherApi._tooOld,
    413 => 'That is too big to send.',
    504 => 'Lee did not answer in time.',
    400 => error ?? 'Lee could not take that send.',
    _ => error ?? 'HTTP $status',
  };
}
