import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:aeronaut/models/attention.dart';
import 'package:aeronaut/models/machine.dart';
import 'package:aeronaut/models/pairing_payload.dart';
import 'package:aeronaut/providers/attention_provider.dart';
import 'package:aeronaut/providers/machines_provider.dart';
import 'package:aeronaut/services/copilot_api.dart';
import 'package:aeronaut/services/machine_store.dart';

const _machine = Machine(id: 'm1', name: 'Dev', host: '127.0.0.1', token: 't');

/// Puts [_machine] in place as the active machine without touching
/// SharedPreferences or starting the health-check timer — same pattern as
/// `someday_screen_test.dart` / `files_screen_test.dart`.
class _FixedMachinesNotifier extends MachinesNotifier {
  _FixedMachinesNotifier() : super(MachineStore()) {
    state = const MachinesState(machines: [_machine], activeMachineId: 'm1');
  }
}

/// Records calls and returns canned data instead of hitting the network, so
/// [AttentionNotifier]'s fetch-and-cache logic can be tested directly.
class _FakeCopilotApi extends CopilotApi {
  _FakeCopilotApi({required super.machine});

  int getItemCalls = 0;
  int getSnapshotCalls = 0;
  AttentionItem? Function(String id)? onGetItem;
  AttentionSnapshot? Function()? onGetSnapshot;

  @override
  Future<AttentionItem?> getItem(String itemId) async {
    getItemCalls++;
    return onGetItem?.call(itemId);
  }

  @override
  Future<AttentionSnapshot?> getSnapshot({bool compact = true}) async {
    getSnapshotCalls++;
    return onGetSnapshot?.call();
  }

  // The real dispose() closes the shared http.Client; this fake is reused
  // across every call in a test so it must survive being "disposed" after
  // each one.
  @override
  void dispose() {}
}

/// A clipped-looking item's text: exactly [kCompactTextClipLength] chars,
/// ending in the clip marker — see `looksClipped`.
String _clippedText([int max = kCompactTextClipLength]) => '${'a' * (max - 1)}…';

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

    test('parses agents when present', () {
      final snapshot = AttentionSnapshot.fromJson({
        'items': [],
        'agents': [
          {
            'pty_id': 3,
            'window_id': 1,
            'tab_id': 12,
            'label': 'Claude: api',
            'provider': 'claude',
            'workspace': '/Users/ben/api',
            'state': 'busy',
            'busy_since': '2026-09-25T14:00:00.000Z',
            'idle_since': null,
            'last_tool': 'Edit',
            'last_summary': null,
            'files_touched_count': 4,
          },
          {'pty_id': 5, 'state': 'something-new'},
        ],
      });
      expect(snapshot.agents, hasLength(2));
      final a = snapshot.agents.first;
      expect(a.ptyId, 3);
      expect(a.windowId, 1);
      expect(a.tabId, 12);
      expect(a.label, 'Claude: api');
      expect(a.state, AgentRunState.busy);
      expect(a.busySince, DateTime.utc(2026, 9, 25, 14));
      expect(a.idleSince, isNull);
      expect(a.lastTool, 'Edit');
      expect(a.filesTouchedCount, 4);
      expect(a.workspaceName, 'api');
      final b = snapshot.agents.last;
      expect(b.state, AgentRunState.unknown, reason: 'unknown states are safe');
      expect(b.label, 'Claude');
      expect(b.tabId, isNull);
    });

    test('agents absent (older Lee) means none', () {
      final snapshot = AttentionSnapshot.fromJson(const {'items': []});
      expect(snapshot.agents, isEmpty);
      final patched = snapshot.copyWith(focus: const FocusState(active: true));
      expect(patched.agents, isEmpty);
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

  group('looksClipped', () {
    test('a short string is never clipped', () {
      expect(looksClipped('short'), isFalse);
    });

    test('a short string that happens to end in the clip marker is still short', () {
      expect(looksClipped('hi…'), isFalse);
    });

    test('exactly the clip length, ending in the marker, looks clipped', () {
      final text = _clippedText();
      expect(text.length, kCompactTextClipLength);
      expect(looksClipped(text), isTrue);
    });

    test('a full-length string NOT ending in the marker is not clipped', () {
      final text = 'a' * kCompactTextClipLength;
      expect(looksClipped(text), isFalse);
    });

    test('a custom max is honored (question strings clip at ~120)', () {
      final text = _clippedText(kCompactQuestionClipLength);
      expect(looksClipped(text, kCompactQuestionClipLength), isTrue);
      // Shorter than the default 280-char item-text clip length.
      expect(looksClipped(text), isFalse);
    });
  });

  group('QuestionSet.singleAnswerable', () {
    test('one single-select question with options is answerable', () {
      const qs = QuestionSet(questions: [
        Question(question: 'Pick one', options: [QuestionOption(label: 'A'), QuestionOption(label: 'B')]),
      ]);
      expect(qs.singleAnswerable?.question, 'Pick one');
      expect(qs.singleAnswerable?.options, hasLength(2));
    });

    test('more than one question is not answerable', () {
      const qs = QuestionSet(questions: [
        Question(question: 'Q1', options: [QuestionOption(label: 'A')]),
        Question(question: 'Q2', options: [QuestionOption(label: 'B')]),
      ]);
      expect(qs.singleAnswerable, isNull);
    });

    test('multi-select is not answerable', () {
      const qs = QuestionSet(questions: [
        Question(question: 'Q', multiSelect: true, options: [QuestionOption(label: 'A')]),
      ]);
      expect(qs.singleAnswerable, isNull);
    });

    test('no options is not answerable', () {
      const qs = QuestionSet(questions: [Question(question: 'Q')]);
      expect(qs.singleAnswerable, isNull);
    });
  });

  group('AttentionItem question kind (Claude\'s AskUserQuestion)', () {
    test('parses kind: question with a nested question set and choose action', () {
      final item = AttentionItem.fromJson({
        'id': 'att_q',
        'kind': 'question',
        'title': 'Claude asks: which approach?',
        'actions': ['choose', 'snooze', 'dismiss'],
        'question': {
          'questions': [
            {
              'question': 'Which approach?',
              'header': 'Approach',
              'multi_select': false,
              'options': [
                {'label': 'A', 'description': 'first'},
                {'label': 'B'},
              ],
            },
          ],
        },
      });
      expect(item.kind, AttentionKind.question);
      expect(item.canChoose, isTrue);
      expect(item.question?.singleAnswerable?.header, 'Approach');
      expect(item.question?.singleAnswerable?.options.map((o) => o.label), ['A', 'B']);
      expect(item.question?.singleAnswerable?.options.first.description, 'first');
    });

    test('question is null when absent, even on a question-kind item (tolerated as absent)', () {
      final item = AttentionItem.fromJson({'id': 'att_q2', 'kind': 'question'});
      expect(item.kind, AttentionKind.question);
      expect(item.question, isNull);
      expect(item.canChoose, isFalse);
    });

    test('choose is only offered when Lee put it in actions, not merely because the shape qualifies', () {
      final item = AttentionItem.fromJson({
        'id': 'att_q3',
        'kind': 'question',
        'actions': ['snooze', 'dismiss'], // no 'choose' — e.g. options carry previews
        'question': {
          'questions': [
            {'question': 'Q', 'options': [{'label': 'A'}]},
          ],
        },
      });
      expect(item.canChoose, isFalse);
      expect(item.question?.singleAnswerable, isNotNull, reason: 'shape alone is not the gate');
    });

    test('an approval whose tool is AskUserQuestion is flagged as a legacy ask (safety net)', () {
      final item = AttentionItem.fromJson({
        'id': 'att_legacy',
        'kind': 'approval',
        'tool': {'name': 'AskUserQuestion', 'preview': '', 'signature': 's'},
        'actions': ['approve', 'deny'],
      });
      expect(item.isLegacyAskQuestionApproval, isTrue);
    });

    test('a plain approval (any other tool) is not flagged', () {
      final item = AttentionItem.fromJson({
        'id': 'att_plain',
        'kind': 'approval',
        'tool': {'name': 'Bash', 'preview': '', 'signature': 's'},
        'actions': ['approve', 'deny'],
      });
      expect(item.isLegacyAskQuestionApproval, isFalse);
    });
  });

  group('AttentionNotifier.fetchFullItem (expand-to-fetch-full-text)', () {
    late _FakeCopilotApi fake;
    late ProviderContainer container;

    AttentionItem clipped({String id = 'att_1', int version = 1}) =>
        AttentionItem(id: id, version: version, text: _clippedText());

    setUp(() {
      fake = _FakeCopilotApi(machine: _machine);
      container = ProviderContainer(overrides: [
        machinesProvider.overrideWith((ref) => _FixedMachinesNotifier()),
        attentionProvider.overrideWith((ref) => AttentionNotifier(ref, apiFactory: (_) => fake)),
      ]);
      addTearDown(container.dispose);
    });

    test('a full fetch replaces the clipped text', () async {
      final item = clipped();
      fake.onGetItem = (id) => AttentionItem(id: id, version: item.version, text: 'the real, full text');
      final full = await container.read(attentionProvider.notifier).fetchFullItem(item);
      expect(full?.text, 'the real, full text');
      expect(fake.getItemCalls, 1);
    });

    test('a second fetch for the same id:version is served from cache (no second request)', () async {
      final item = clipped();
      fake.onGetItem = (id) => AttentionItem(id: id, version: item.version, text: 'full');
      final notifier = container.read(attentionProvider.notifier);
      await notifier.fetchFullItem(item);
      await notifier.fetchFullItem(item);
      expect(fake.getItemCalls, 1);
    });

    test('a version bump fetches again (a new id:version key)', () async {
      final notifier = container.read(attentionProvider.notifier);
      fake.onGetItem = (id) => const AttentionItem(id: 'att_1', version: 1, text: 'full v1');
      final full1 = await notifier.fetchFullItem(clipped(version: 1));
      fake.onGetItem = (id) => const AttentionItem(id: 'att_1', version: 2, text: 'full v2');
      final full2 = await notifier.fetchFullItem(clipped(version: 2));
      expect(full1?.text, 'full v1');
      expect(full2?.text, 'full v2');
      expect(fake.getItemCalls, 2);
    });

    test('404/410 (item gone) resolves to null — caller keeps showing the clipped text', () async {
      fake.onGetItem = (_) => null;
      final full = await container.read(attentionProvider.notifier).fetchFullItem(clipped());
      expect(full, isNull);
      expect(fake.getItemCalls, 1);
    });

    test('short (unclipped) text never triggers a fetch', () async {
      const short = AttentionItem(id: 'att_short', version: 1, text: 'short and sweet');
      final full = await container.read(attentionProvider.notifier).fetchFullItem(short);
      expect(full, isNull);
      expect(fake.getItemCalls, 0);
    });

    test('empty text never triggers a fetch', () async {
      const empty = AttentionItem(id: 'att_empty', version: 1, text: '');
      final full = await container.read(attentionProvider.notifier).fetchFullItem(empty);
      expect(full, isNull);
      expect(fake.getItemCalls, 0);
    });
  });

  group('AttentionNotifier.fetchFullSnapshot / fetchFullAgentSummary (In-flight full summary)', () {
    late _FakeCopilotApi fake;
    late ProviderContainer container;

    setUp(() async {
      fake = _FakeCopilotApi(machine: _machine);
      container = ProviderContainer(overrides: [
        machinesProvider.overrideWith((ref) => _FixedMachinesNotifier()),
        attentionProvider.overrideWith((ref) => AttentionNotifier(ref, apiFactory: (_) => fake)),
      ]);
      addTearDown(container.dispose);
      // Constructing the notifier (first read) fires its own (unawaited)
      // refresh() — force that construction now, let it settle, and reset
      // the counter so each test only counts the calls it actually makes.
      container.read(attentionProvider.notifier);
      await Future<void>.delayed(Duration.zero);
      fake.getSnapshotCalls = 0;
    });

    test('returns the agent matching ptyId, with its unclipped summary', () async {
      fake.onGetSnapshot = () => const AttentionSnapshot(
            agents: [AgentSummary(ptyId: 3, lastSummary: 'the full unclipped summary')],
          );
      final agent = await container.read(attentionProvider.notifier).fetchFullAgentSummary(3);
      expect(agent?.lastSummary, 'the full unclipped summary');
      expect(fake.getSnapshotCalls, 1);
    });

    test('a second expand shortly after reuses the cached snapshot (no second request)', () async {
      fake.onGetSnapshot = () => const AttentionSnapshot(agents: [AgentSummary(ptyId: 3, lastSummary: 'x')]);
      final notifier = container.read(attentionProvider.notifier);
      await notifier.fetchFullAgentSummary(3);
      await notifier.fetchFullAgentSummary(3);
      expect(fake.getSnapshotCalls, 1);
    });

    test('an unknown ptyId resolves to null without erroring', () async {
      fake.onGetSnapshot = () => const AttentionSnapshot(agents: [AgentSummary(ptyId: 3, lastSummary: 'x')]);
      final agent = await container.read(attentionProvider.notifier).fetchFullAgentSummary(99);
      expect(agent, isNull);
    });
  });
}
