import 'package:aeronaut/models/machine.dart';
import 'package:aeronaut/models/pairing_payload.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Machine.isTailnetAddress', () {
    test('100.64.0.0/10 and ts.net names', () {
      expect(Machine.isTailnetAddress('100.72.102.73'), isTrue);
      expect(Machine.isTailnetAddress('100.127.0.1'), isTrue);
      expect(Machine.isTailnetAddress('mini-m1.tail1234.ts.net'), isTrue);
    });
    test('LAN and other 100.x addresses are not', () {
      expect(Machine.isTailnetAddress('192.168.1.5'), isFalse);
      expect(Machine.isTailnetAddress('100.63.0.1'), isFalse);
      expect(Machine.isTailnetAddress('100.128.0.1'), isFalse);
    });
  });

  group('Machine.hostCandidates', () {
    const m = Machine(
      id: 'a',
      name: 'mini-m1',
      host: '100.72.102.73',
      lanHost: '10.1.0.20',
      tailnetHost: '100.72.102.73',
    );
    test('tailnet first when the phone is on it', () {
      expect(m.hostCandidates(onTailnet: true), ['100.72.102.73', '10.1.0.20']);
    });
    test('local first when it is not', () {
      expect(m.hostCandidates(onTailnet: false), ['10.1.0.20', '100.72.102.73']);
    });
    test('a manual entry has only its host', () {
      const manual = Machine(id: 'b', name: 'x', host: '192.168.1.9');
      expect(manual.hostCandidates(onTailnet: true), ['192.168.1.9']);
    });
    test('route label follows host', () {
      expect(m.routeLabel, 'Tailscale');
      expect(m.copyWith(host: '10.1.0.20').routeLabel, 'Local');
    });
    test('both addresses survive a JSON round trip', () {
      final back = Machine.fromJson(m.toJson());
      expect(back.lanHost, '10.1.0.20');
      expect(back.tailnetHost, '100.72.102.73');
    });
  });

  test('PairingPayload reads lanHost and tailnetHost', () {
    final p = PairingPayload.parse(
      '{"host":"100.72.102.73","lanHost":"10.1.0.20","tailnetHost":"100.72.102.73",'
      '"hostPort":9001,"ticket":"t","pairVersion":2}',
    );
    expect(p.kind, PairingPayloadKind.ticket);
    expect(p.lanHost, '10.1.0.20');
    expect(p.tailnetHost, '100.72.102.73');
  });
}
