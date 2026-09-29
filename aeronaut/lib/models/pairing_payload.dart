import 'dart:convert';

/// Which pairing wire format a scanned QR code used.
///
/// v1 (older Lee): the QR carries a `token` directly. v2 (contracts §4.2,
/// §9.2, `pairVersion: 2`): the QR carries a single-use `ticket` to redeem
/// at `POST /pair/redeem`; the shared token never leaves the machine.
enum PairingPayloadKind { ticket, token, invalid }

/// Parsed payload from Lee's Aeronaut pairing QR code
/// (`aeronaut:get-pairing-qr` in `electron/src/main/main.ts`).
///
/// Kept separate from `QrScannerScreen` so the parsing (including the v1
/// vs v2 branch) is unit-testable without pumping a widget tree that needs
/// a camera plugin.
class PairingPayload {
  final PairingPayloadKind kind;
  final String? host;
  final String? name;
  final int? hostPort;
  final int? hesterPort;
  final String? ticket;
  final String? token;
  final String? error;

  /// The machine's local-network and tailnet addresses, when Lee sent both
  /// (`host` is then the tailnet one, for older builds that read only it).
  final String? lanHost;
  final String? tailnetHost;

  const PairingPayload._({
    required this.kind,
    this.host,
    this.name,
    this.hostPort,
    this.hesterPort,
    this.ticket,
    this.token,
    this.error,
    this.lanHost,
    this.tailnetHost,
  });

  factory PairingPayload.parse(String raw) {
    final Map<String, dynamic> json;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) throw const FormatException();
      json = decoded;
    } catch (_) {
      return const PairingPayload._(
        kind: PairingPayloadKind.invalid,
        error: 'Invalid QR code - not a Lee pairing code.',
      );
    }

    final host = json['host'] as String?;
    if (host == null || host.isEmpty) {
      return const PairingPayload._(
        kind: PairingPayloadKind.invalid,
        error: 'QR code missing host address.',
      );
    }
    final name = json['name'] as String?;
    final hostPort = _port(json, const ['hostPort', 'apiPort', 'leePort']);
    final hesterPort = _port(json, const ['hesterPort', 'daemonPort']);
    final lanHost = _host(json['lanHost']);
    final tailnetHost = _host(json['tailnetHost']);

    final ticket = (json['ticket'] as String?)?.trim();
    if (ticket != null && ticket.isNotEmpty) {
      return PairingPayload._(
        kind: PairingPayloadKind.ticket,
        host: host,
        name: name,
        hostPort: hostPort,
        hesterPort: hesterPort,
        ticket: ticket,
        lanHost: lanHost,
        tailnetHost: tailnetHost,
      );
    }

    final token = (json['token'] as String?)?.trim();
    if (token != null && token.isNotEmpty) {
      return PairingPayload._(
        kind: PairingPayloadKind.token,
        host: host,
        name: name,
        hostPort: hostPort,
        hesterPort: hesterPort,
        token: token,
        lanHost: lanHost,
        tailnetHost: tailnetHost,
      );
    }

    return const PairingPayload._(
      kind: PairingPayloadKind.invalid,
      error: 'QR code missing a pairing token or ticket.',
    );
  }

  static String? _host(Object? value) {
    final s = value is String ? value.trim() : null;
    return (s == null || s.isEmpty) ? null : s;
  }

  /// Read the first present port key, tolerating numbers sent as strings.
  static int? _port(Map<String, dynamic> json, List<String> keys) {
    for (final key in keys) {
      final value = json[key];
      if (value is num) return value.toInt();
      if (value is String) {
        final parsed = int.tryParse(value.trim());
        if (parsed != null) return parsed;
      }
    }
    return null;
  }
}
