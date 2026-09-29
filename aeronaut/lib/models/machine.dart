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
    );
  }

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
      ];
}
