import 'package:flutter_test/flutter_test.dart';
import 'package:aeronaut/models/attention.dart';
import 'package:aeronaut/models/pairing_payload.dart';
import 'package:aeronaut/providers/attention_provider.dart';

void main() {
  group('AttentionItem.fromJson', () {
    test('parses the full form', () {
      final item = AttentionItem.fromJson({
        'id': 'att_1',
        'version': 3,
        'kind': 'approval',
        'severity': 'blocking',
        'state': 'open',
        'parked': false,
        'wake': false,
        'notify': true,
        'related_to_focus': true,
        'created_at': '2026-09-25T14:00:00.000Z',
        'updated_at': '2026-09-25T14:00:01.000Z',
        'active_wait_ms': 120000,
        'title': 'Claude wants to use Bash',
        'text': 'Run "npm test"?',
        'source': {
          'kind': 'agent',
          'provider': 'claude',
          'session_id': 's1',
          'pty_id': 12,
          'window_id': 1,
          'tab_id': 3,
          'tab_label': 'Claude',
          'workspace': '/Users/ben/Development/Lee',
          'cwd': '/Users/ben/Development/Lee',
        },
        'files': ['a.ts', 'b.ts'],
        'tool': {'name': 'Bash', 'preview': 'npm test', 'signature': 'abc123'},
        'lee_status': {
          'status': 'blocked',
          'summary': 'stuck',
          'blockers': 'need input',
          'files': ['a.ts'],
          'next': null,
        },
        'actions': ['approve', 'deny', 'open', 'snooze', 'dismiss'],
        'snoozed_until': null,
      });

      expect(item.id, 'att_1');
      expect(item.version, 3);
      expect(item.kind, AttentionKind.approval);
      expect(item.severity, AttentionSeverity.blocking);
      expect(item.state, AttentionItemState.open);
      expect(item.notify, isTrue);
      expect(item.relatedToFocus, isTrue);
      expect(item.activeWaitMs, 120000);
      expect(item.title, 'Claude wants to use Bash');
      expect(item.source.tabLabel, 'Claude');
      expect(item.source.workspaceName, 'Lee');
      expect(item.sourceLabel, 'Claude · Lee');
      expect(item.files, ['a.ts', 'b.ts']);
      expect(item.tool?.name, 'Bash');
      expect(item.leeStatus?.status, 'blocked');
      expect(item.actions, contains(AttentionActionName.approve));
      expect(item.canApproveDeny, isTrue);
      expect(item.canSnooze, isTrue);
      expect(item.canDismiss, isTrue);
      expect(item.canReply, isFalse);
      expect(item.createdAt, DateTime.parse('2026-09-25T14:00:00.000Z'));
    });

    test('parses the compact form (?compact=1): no files, short text', () {
      final item = AttentionItem.fromJson({
        'id': 'att_2',
        'version': 1,
        'kind': 'waiting',
        'severity': 'needs-you',
        'state': 'open',
        'title': 'Claude is waiting for you',
        'text': 'Short summary',
        'source': {'tab_label': 'Terminal 1'},
        'actions': ['reply', 'open', 'snooze', 'dismiss', 'wake'],
      });

      expect(item.kind, AttentionKind.waiting);
      expect(item.severity, AttentionSeverity.needsYou);
      expect(item.files, isNull); // compact omits files entirely
      expect(item.canReply, isTrue);
      expect(item.canWake, isTrue);
      expect(item.sourceLabel, 'Terminal 1');
    });

    test('missing fields fall back to safe defaults', () {
      final item = AttentionItem.fromJson(const {});
      expect(item.id, '');
      expect(item.kind, AttentionKind.waiting);
      expect(item.severity, AttentionSeverity.ambient);
      expect(item.state, AttentionItemState.open);
      expect(item.actions, isEmpty);
      expect(item.sourceLabel, '');
    });

    test('unknown action names are dropped, not thrown', () {
      final item = AttentionItem.fromJson({
        'id': 'att_3',
        'actions': ['approve', 'some_future_action'],
      });
      expect(item.actions, [AttentionActionName.approve]);
    });
  });

  group('FocusItem', () {
    test('round-trips the agent variant', () {
      final item = FocusItem.agent(ptyId: 7, windowId: 1, label: 'Claude');
      final restored = FocusItem.fromJson(item.toJson());
      expect(restored.kind, FocusItemKind.agent);
      expect(restored.ptyId, 7);
      expect(restored.displayLabel, 'Claude');
    });

    test('round-trips the files variant', () {
      final item = FocusItem.files(workspace: '/ws', paths: ['/ws/a.ts', '/ws/b.ts']);
      final restored = FocusItem.fromJson(item.toJson());
      expect(restored.kind, FocusItemKind.files);
      expect(restored.paths, ['/ws/a.ts', '/ws/b.ts']);
      expect(restored.displayLabel, 'a.ts, b.ts');
    });

    test('round-trips the workspace variant', () {
      final item = FocusItem.workspace('/Users/ben/Development/Lee');
      final restored = FocusItem.fromJson(item.toJson());
      expect(restored.kind, FocusItemKind.workspace);
      expect(restored.displayLabel, 'Lee');
    });
  });

  group('AttentionSnapshot.fromJson', () {
    test('parses items, counts, focus and away together', () {
      final snapshot = AttentionSnapshot.fromJson({
        'items': [
          {'id': 'a1', 'kind': 'review', 'severity': 'ambient', 'state': 'open'},
          {'id': 'a2', 'kind': 'blocker', 'severity': 'blocking', 'state': 'open'},
        ],
        'counts': {'blocking': 1, 'needs_you': 0, 'ambient': 1, 'parked': 0},
        'focus': {
          'active': true,
          'session_id': 'f1',
          'source': 'manual',
          'item': {'kind': 'workspace', 'workspace': '/ws'},
          'quiet_count': 2,
        },
        'away': {'active': false, 'parked_count': 0},
        'generated_at': '2026-09-25T14:05:00.000Z',
      });

      expect(snapshot.items, hasLength(2));
      expect(snapshot.counts.blocking, 1);
      expect(snapshot.counts.needsAttention, 1);
      expect(snapshot.focus.active, isTrue);
      expect(snapshot.focus.item?.kind, FocusItemKind.workspace);
      expect(snapshot.focus.quietCount, 2);
      expect(snapshot.away.active, isFalse);
    });

    test('missing sub-objects fall back to empty defaults', () {
      final snapshot = AttentionSnapshot.fromJson(const {});
      expect(snapshot.items, isEmpty);
      expect(snapshot.counts.blocking, 0);
      expect(snapshot.focus.active, isFalse);
      expect(snapshot.away.active, isFalse);
    });

    test('copyWith patches one field without touching the rest', () {
      const snapshot = AttentionSnapshot(counts: AttentionCounts(blocking: 1));
      final patched = snapshot.copyWith(focus: const FocusState(active: true));
      expect(patched.focus.active, isTrue);
      expect(patched.counts.blocking, 1);
    });
  });

  group('ActionResult / CaptureResult', () {
    test('ActionResult carries the updated item on success', () {
      final result = ActionResult.fromJson({
        'success': true,
        'item': {'id': 'a1', 'version': 2},
      });
      expect(result.success, isTrue);
      expect(result.item?.version, 2);
    });

    test('CaptureResult reports spooled delivery', () {
      final result = CaptureResult.fromJson({
        'success': true,
        'spooled': true,
        'someday_id': null,
      });
      expect(result.success, isTrue);
      expect(result.spooled, isTrue);
      expect(result.somedayId, isNull);
    });
  });

  group('SummaryPolicy', () {
    test('round-trips the "at" variant with a timestamp', () {
      final policy = SummaryPolicy.at(DateTime.utc(2026, 9, 25, 18));
      final json = policy.toJson();
      final restored = SummaryPolicy.fromJson(json);
      expect(restored.mode, SummaryPolicyMode.at);
      expect(restored.at, DateTime.utc(2026, 9, 25, 18));
    });

    test('unknown mode falls back to on_return', () {
      final restored = SummaryPolicy.fromJson({'mode': 'something-new'});
      expect(restored.mode, SummaryPolicyMode.onReturn);
    });
  });

  group('PairingPayload.parse', () {
    test('v2: a ticket payload is parsed as PairingPayloadKind.ticket', () {
      final payload = PairingPayload.parse('''
        {"name":"bens-mbp","host":"192.168.1.10","hostPort":9001,"hesterPort":9000,
         "ticket":"5c0e1234567890abcd1234567890abcd","ticketExpiresIn":600,"pairVersion":2}
      ''');
      expect(payload.kind, PairingPayloadKind.ticket);
      expect(payload.host, '192.168.1.10');
      expect(payload.hostPort, 9001);
      expect(payload.hesterPort, 9000);
      expect(payload.ticket, isNotEmpty);
      expect(payload.token, isNull);
    });

    test('v1: a token payload is parsed as PairingPayloadKind.token', () {
      final payload = PairingPayload.parse('''
        {"name":"bens-mbp","host":"192.168.1.10","hostPort":9001,"hesterPort":9000,
         "token":"11111111-2222-3333-4444-555555555555"}
      ''');
      expect(payload.kind, PairingPayloadKind.token);
      expect(payload.token, '11111111-2222-3333-4444-555555555555');
      expect(payload.ticket, isNull);
    });

    test('a ticket takes priority when a payload somehow carries both', () {
      final payload = PairingPayload.parse('''
        {"host":"h","ticket":"tix","token":"tok"}
      ''');
      expect(payload.kind, PairingPayloadKind.ticket);
    });

    test('port aliases and string-typed ports are tolerated', () {
      final payload = PairingPayload.parse('''
        {"host":"h","token":"t","apiPort":"9101","daemonPort":9200}
      ''');
      expect(payload.hostPort, 9101);
      expect(payload.hesterPort, 9200);
    });

    test('missing host is invalid', () {
      final payload = PairingPayload.parse('{"token":"t"}');
      expect(payload.kind, PairingPayloadKind.invalid);
      expect(payload.error, isNotNull);
    });

    test('missing token and ticket is invalid', () {
      final payload = PairingPayload.parse('{"host":"h"}');
      expect(payload.kind, PairingPayloadKind.invalid);
    });

    test('malformed JSON is invalid, not a throw', () {
      final payload = PairingPayload.parse('not json');
      expect(payload.kind, PairingPayloadKind.invalid);
    });
  });

  group('notify edge detection (contracts §9.2)', () {
    AttentionItem item(String id, {bool notify = false}) =>
        AttentionItem(id: id, notify: notify);

    test('notifyingIds collects only items with notify true', () {
      final snapshot = AttentionSnapshot(items: [
        item('a', notify: true),
        item('b', notify: false),
        item('c', notify: true),
      ]);
      expect(notifyingIds(snapshot), {'a', 'c'});
    });

    test('notifyRoseItems yields an item whose notify just went true', () {
      final snapshot = AttentionSnapshot(items: [item('a', notify: true)]);
      final rose = notifyRoseItems({}, snapshot).toList();
      expect(rose.map((i) => i.id), ['a']);
    });

    test('notifyRoseItems does not re-fire for an item already notifying', () {
      final snapshot = AttentionSnapshot(items: [item('a', notify: true)]);
      final rose = notifyRoseItems({'a'}, snapshot).toList();
      expect(rose, isEmpty);
    });

    test('notifyRoseItems ignores items whose notify is still false', () {
      final snapshot = AttentionSnapshot(items: [item('a', notify: false)]);
      final rose = notifyRoseItems({}, snapshot).toList();
      expect(rose, isEmpty);
    });

    test('notifyRoseItems fires again after notify flips back on', () {
      // Simulates the caller re-baselining with notifyingIds() between
      // flips, as AttentionNotifier._applyNotifyEdge does on every snapshot.
      final on = AttentionSnapshot(items: [item('a', notify: true)]);
      final off = AttentionSnapshot(items: [item('a', notify: false)]);

      var previously = notifyRoseItems({}, on).toList().isNotEmpty
          ? notifyingIds(on)
          : <String>{};
      expect(previously, {'a'});

      previously = notifyingIds(off);
      expect(previously, isEmpty);

      final roseAgain = notifyRoseItems(previously, on).toList();
      expect(roseAgain.map((i) => i.id), ['a']);
    });

    test('a mixed snapshot only yields the items that newly flipped', () {
      final snapshot = AttentionSnapshot(items: [
        item('a', notify: true), // already notifying
        item('b', notify: true), // newly notifying
        item('c', notify: false), // never notified
      ]);
      final rose = notifyRoseItems({'a'}, snapshot).toList();
      expect(rose.map((i) => i.id), ['b']);
    });
  });
}
