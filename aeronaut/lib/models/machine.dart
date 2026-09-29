import 'package:equatable/equatable.dart';

/// A saved Lee instance connection.
///
/// Each machine represents a running Lee + optional Hester daemon
/// on the local network, identified by (host, hostPort, workspace).
class Machine extends Equatable {
  final String id;
  final String name;
  final String host;
  final int hostPort;
  final int? hesterPort;
  final String token;
  final String? workspace;
  final DateTime? lastSeen;

  /// This device's own id on Lee (`dev_...`), issued at pairing under the
  /// per-device token scheme (contracts §4). Null for a machine still
  /// holding a pre-Copilot shared-token QR pairing (v1 payload).
  final String? deviceId;

  /// The machine's address on the local network and on the tailnet, when
  /// the pairing QR carried them. [host] is whichever of the two answered
  /// last (see `MachinesNotifier`); a manually added machine has neither.
  final String? lanHost;
  final String? tailnetHost;

  const Machine({
    required this.id,
    required this.name,
    required this.host,
    this.hostPort = 9001,
    this.hesterPort = 9000,
    this.token = '',
    this.workspace,
    this.lastSeen,
    this.deviceId,
    this.lanHost,
    this.tailnetHost,
  });

  Machine copyWith({
    String? id,
    String? name,
    String? host,
    int? hostPort,
    int? hesterPort,
    String? token,
    String? workspace,
    DateTime? lastSeen,
    String? deviceId,
    String? lanHost,
    String? tailnetHost,
  }) {
    return Machine(
      id: id ?? this.id,
      name: name ?? this.name,
      host: host ?? this.host,
      hostPort: hostPort ?? this.hostPort,
      hesterPort: hesterPort ?? this.hesterPort,
      token: token ?? this.token,
      workspace: workspace ?? this.workspace,
      lastSeen: lastSeen ?? this.lastSeen,
      deviceId: deviceId ?? this.deviceId,
      lanHost: lanHost ?? this.lanHost,
      tailnetHost: tailnetHost ?? this.tailnetHost,
    );
  }

  /// Tailscale hands out 100.64.0.0/10 addresses and `*.ts.net` names.
  static bool isTailnetAddress(String host) {
    if (host.endsWith('.ts.net')) return true;
    final parts = host.split('.');
    if (parts.length != 4) return false;
    final a = int.tryParse(parts[0]);
    final b = int.tryParse(parts[1]);
    return a == 100 && b != null && b >= 64 && b <= 127;
  }

  /// Addresses to try, best first: the tailnet when this phone is on it,
  /// otherwise the local network, then the other, then [host] if it's
  /// neither (a manual entry).
  List<String> hostCandidates({required bool onTailnet}) {
    final ordered = onTailnet ? [tailnetHost, lanHost] : [lanHost, tailnetHost];
    return {...ordered.whereType<String>(), host}.toList();
  }

  /// Whether [host] is a known address of this machine.
  bool knowsHost(String address) =>
      address == host || address == lanHost || address == tailnetHost;

  /// "Tailscale" or "Local", for the route [host] is on.
  String get routeLabel => isTailnetAddress(host) ? 'Tailscale' : 'Local';

  /// Base URL for Lee Host API
  String get hostUrl => 'http://$host:$hostPort';

  /// Base URL for Hester daemon API (null if no hester port)
  String? get hesterUrl =>
      hesterPort != null ? 'http://$host:$hesterPort' : null;

  /// WebSocket URL for context stream
  String get contextStreamUrl => wsUrl('/context/stream');

  /// Build a WebSocket URL with auth token query param.
  String wsUrl(String path) {
    final base = 'ws://$host:$hostPort$path';
    return token.isNotEmpty ? '$base?token=${Uri.encodeComponent(token)}' : base;
  }

  /// Display label: "name (workspace)" or just "name"
  String get displayLabel =>
      workspace != null ? '$name ($workspace)' : name;

  factory Machine.fromJson(Map<String, dynamic> json) {
    return Machine(
      id: json['id'] as String,
      name: json['name'] as String,
      host: json['host'] as String,
      hostPort: json['hostPort'] as int? ?? 9001,
      hesterPort: json['hesterPort'] as int?,
      token: json['token'] as String? ?? '',
      workspace: json['workspace'] as String?,
      lastSeen: json['lastSeen'] != null
          ? DateTime.tryParse(json['lastSeen'] as String)
          : null,
      deviceId: json['deviceId'] as String?,
      lanHost: json['lanHost'] as String?,
      tailnetHost: json['tailnetHost'] as String?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'host': host,
      'hostPort': hostPort,
      'hesterPort': hesterPort,
      'token': token,
      'workspace': workspace,
      'lastSeen': lastSeen?.toIso8601String(),
      'deviceId': deviceId,
      'lanHost': lanHost,
      'tailnetHost': tailnetHost,
    };
  }

  @override
  List<Object?> get props => [
        id,
        name,
        host,
        hostPort,
        hesterPort,
        token,
        workspace,
        lastSeen,
        deviceId,
        lanHost,
        tailnetHost,
      ];
}
