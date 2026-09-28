import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../models/machine.dart';
import '../models/voice.dart';
import 'api_auth.dart';

/// Hester's voice routes (docs/plans/2026-09-28-tether-review-voice.md
/// §5.2): `GET /voice` and `POST /voice/transcribe`, the clip as the raw
/// request body (16 kHz mono PCM16 WAV), not base64 JSON. Hester never
/// keeps the audio or the text.
class VoiceApi {
  final Machine machine;
  final http.Client _client;

  VoiceApi({required this.machine, http.Client? client}) : _client = client ?? http.Client();

  String? get _baseUrl => machine.hesterUrl;

  Map<String, String> get _auth => {
        if (machine.token.isNotEmpty) 'Authorization': 'Bearer ${machine.token}',
      };

  bool _isUnauthorized(http.BaseResponse response) {
    if (response.statusCode != 401) return false;
    ApiAuth.reportUnauthorized(machine.id, ApiService.hester);
    return true;
  }

  /// `GET /voice`. [VoiceCapabilities.unavailable] on any failure, so the
  /// mic simply stays hidden.
  Future<VoiceCapabilities> capabilities() async {
    if (_baseUrl == null) return VoiceCapabilities.unavailable;
    try {
      final response =
          await _client.get(Uri.parse('$_baseUrl/voice'), headers: _auth).timeout(const Duration(seconds: 5));
      if (_isUnauthorized(response)) return VoiceCapabilities.unavailable;
      if (response.statusCode == 200) {
        final json = jsonDecode(response.body);
        final data = json is Map<String, dynamic> && json['data'] is Map<String, dynamic> ? json['data'] : json;
        if (data is Map<String, dynamic>) return VoiceCapabilities.fromJson(data);
      }
    } catch (_) {
      // Hester offline or too old: no mic.
    }
    return VoiceCapabilities.unavailable;
  }

  /// `POST /voice/transcribe?purpose=&item_id=&workspace=`.
  Future<({TranscribeResult? result, VoiceErrorCode? error})> transcribe(
    Uint8List wav, {
    required VoicePurpose purpose,
    String? itemId,
    String? workspace,
  }) async {
    if (_baseUrl == null) return (result: null, error: VoiceErrorCode.voiceUnavailable);
    final uri = Uri.parse('$_baseUrl/voice/transcribe').replace(queryParameters: {
      'purpose': purpose.name,
      if (itemId != null) 'item_id': itemId,
      if (workspace != null) 'workspace': workspace,
    });
    try {
      final response = await _client
          .post(uri, headers: {..._auth, 'Content-Type': 'audio/wav'}, body: wav)
          .timeout(const Duration(seconds: 40));
      if (_isUnauthorized(response)) return (result: null, error: VoiceErrorCode.network);
      if (response.statusCode == 200) {
        final json = jsonDecode(response.body);
        final data = json is Map<String, dynamic> && json['data'] is Map<String, dynamic> ? json['data'] : json;
        if (data is Map<String, dynamic>) return (result: TranscribeResult.fromJson(data), error: null);
        return (result: null, error: VoiceErrorCode.providerError);
      }
      String? code;
      try {
        final json = jsonDecode(response.body);
        if (json is Map<String, dynamic>) code = json['error'] as String?;
      } catch (_) {
        // not JSON
      }
      return (result: null, error: VoiceErrorCode.fromWire(code) ?? VoiceErrorCode.fromStatus(response.statusCode));
    } catch (_) {
      return (result: null, error: VoiceErrorCode.network);
    }
  }

  void dispose() {
    _client.close();
  }
}
