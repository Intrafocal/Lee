/// Shared handling for bearer-token rejection (HTTP 401).
///
/// Lee (`:9001`) and Hester (`:9000`) both require
/// `Authorization: Bearer <token>` on every route except `GET /health`.
/// The token lives in `~/.lee/api-token` on the machine running Lee and is
/// handed to Aeronaut by the pairing QR code.
///
/// Both API clients are constructed ad hoc all over the app, so rather than
/// threading a callback through every call site they report a 401 here and a
/// single listener (`authGuardProvider`) turns it into UI state.
library;

/// Which service rejected the token.
enum ApiService {
  lee,
  hester;

  String get label => this == ApiService.lee ? 'Lee' : 'Hester';
}

/// Outcome of an authenticated request, for callers that need to tell
/// "unreachable" apart from "token rejected".
enum ApiStatus {
  ok,
  unauthorized,
  unreachable,
}

/// Reported when a machine's token is rejected.
class AuthFailure {
  final String machineId;
  final ApiService service;

  const AuthFailure({required this.machineId, required this.service});

  /// The single message the UI shows for a rejected token.
  static const message = 'Token rejected. Re-pair this machine.';

  String get detail =>
      '${service.label} rejected the saved token for this machine.';
}

typedef UnauthorizedHandler = void Function(AuthFailure failure);

/// Process-wide sink for 401s. `authGuardProvider` installs the handler.
class ApiAuth {
  ApiAuth._();

  static UnauthorizedHandler? handler;

  static void reportUnauthorized(String machineId, ApiService service) {
    if (machineId.isEmpty) return;
    handler?.call(AuthFailure(machineId: machineId, service: service));
  }
}
