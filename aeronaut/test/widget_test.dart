import 'package:flutter_test/flutter_test.dart';
import 'package:aeronaut/models/machine.dart';
import 'package:aeronaut/models/lee_context.dart';

void main() {
  group('Machine', () {
    test('serializes to and from JSON', () {
      final machine = Machine(
        id: 'test-id',
        name: 'MacBook Pro',
        host: '192.168.1.100',
        hostPort: 9001,
        hesterPort: 9000,
        token: 'test-token',
        workspace: '/Users/ben/projects',
        lastSeen: DateTime(2026, 1, 1),
      );

      final json = machine.toJson();
      final restored = Machine.fromJson(json);

      expect(restored.id, machine.id);
      expect(restored.name, machine.name);
      expect(restored.host, machine.host);
      expect(restored.hostPort, machine.hostPort);
      expect(restored.hesterPort, machine.hesterPort);
      expect(restored.token, machine.token);
      expect(restored.workspace, machine.workspace);
    });

    test('computes hostUrl correctly', () {
      const machine = Machine(
        id: '1',
        name: 'Test',
        host: '192.168.1.100',
        hostPort: 9001,
      );
      expect(machine.hostUrl, 'http://192.168.1.100:9001');
    });

    test('computes contextStreamUrl correctly', () {
      const machine = Machine(
        id: '1',
        name: 'Test',
        host: '192.168.1.100',
        hostPort: 9001,
      );
      expect(
        machine.contextStreamUrl,
        'ws://192.168.1.100:9001/context/stream',
      );
    });
  });

  group('LeeContext', () {
    test('parses from JSON', () {
      final json = {
        'workspace': '/Users/ben/project',
        'focusedPanel': 'center',
        'tabs': [
          {
            'id': 1,
            'type': 'editor',
            'label': 'main.py',
            'ptyId': null,
            'dockPosition': 'center',
            'state': 'active',
          },
          {
            'id': 2,
            'type': 'terminal',
            'label': 'Terminal 1',
            'ptyId': 3,
            'dockPosition': 'center',
            'state': 'background',
          },
        ],
        'panels': {
          'center': {'activeTabId': 1, 'visible': true, 'size': 100},
        },
        'editor': {
          'file': '/Users/ben/project/main.py',
          'language': 'python',
          'cursor': {'line': 42, 'column': 5},
          'selection': null,
          'modified': true,
        },
        'activity': {
          'lastInteraction': 1234567890,
          'idleSeconds': 10,
          'sessionDuration': 3600,
        },
        'timestamp': 1234567890,
      };

      final ctx = LeeContext.fromJson(json);

      expect(ctx.workspace, '/Users/ben/project');
      expect(ctx.workspaceName, 'project');
      expect(ctx.tabs.length, 2);
      expect(ctx.tabs[0].type, TabType.editor);
      expect(ctx.tabs[0].label, 'main.py');
      expect(ctx.tabs[1].type, TabType.terminal);
      expect(ctx.tabs[1].ptyId, 3);
      expect(ctx.editor?.file, '/Users/ben/project/main.py');
      expect(ctx.editor?.cursor.line, 42);
      expect(ctx.editor?.modified, true);
      expect(ctx.editor?.fileName, 'main.py');
      expect(ctx.activeTab?.id, 1);
    });

    test('handles hester-qa tab type', () {
      final tabType = TabType.fromString('hester-qa');
      expect(tabType, TabType.hesterQa);
    });

    test('parses the per-tab editors map (D10: was on the wire, unused)', () {
      final ctx = LeeContext.fromJson({
        'workspace': '/ws',
        'tabs': [
          {'id': 1, 'type': 'editor', 'label': 'a.py'},
          {'id': 2, 'type': 'file', 'label': 'b.md'},
        ],
        'editors': {
          '1': {'file': '/ws/a.py', 'language': 'python', 'modified': false},
          '2': {'file': '/ws/b.md', 'language': 'markdown', 'modified': true},
        },
      });

      expect(ctx.editors.length, 2);
      expect(ctx.editors[1]?.file, '/ws/a.py');
      expect(ctx.editors[2]?.modified, isTrue);

      final tabA = ctx.tabs.firstWhere((t) => t.id == 1);
      final tabB = ctx.tabs.firstWhere((t) => t.id == 2);
      expect(ctx.editorFor(tabA)?.file, '/ws/a.py');
      expect(ctx.editorFor(tabB)?.language, 'markdown');
    });

    test('editorFor falls back to the legacy single editor field when no '
        'per-tab editors map was sent', () {
      final ctx = LeeContext.fromJson({
        'workspace': '/ws',
        'tabs': [
          {'id': 1, 'type': 'editor', 'label': 'a.py'},
        ],
        'editor': {'file': '/ws/a.py', 'language': 'python'},
      });

      final tab = ctx.tabs.first;
      expect(ctx.editors, isEmpty);
      expect(ctx.editorFor(tab)?.file, '/ws/a.py');
    });

    test('editorFor returns null for a non-editor-like tab with no entry', () {
      final ctx = LeeContext.fromJson({
        'workspace': '/ws',
        'tabs': [
          {'id': 1, 'type': 'pdf', 'label': 'doc.pdf'},
        ],
      });
      expect(ctx.editorFor(ctx.tabs.first), isNull);
    });
  });

  group('TabType', () {
    test('maps every wire value Lee can send', () {
      const wireValues = <String, TabType>{
        'editor': TabType.editor,
        'editor-panel': TabType.editorPanel,
        'file': TabType.file,
        'terminal': TabType.terminal,
        'git': TabType.git,
        'docker': TabType.docker,
        'k8s': TabType.k8s,
        'flutter': TabType.flutter,
        'hester': TabType.hester,
        'claude': TabType.claude,
        'agent': TabType.agent,
        'files': TabType.files,
        'browser': TabType.browser,
        'hester-qa': TabType.hesterQa,
        'devops': TabType.devops,
        'system': TabType.system,
        'sql': TabType.sql,
        'library': TabType.library,
        'workstream': TabType.workstream,
        'spyglass': TabType.spyglass,
        'bridge': TabType.bridge,
        'kicad': TabType.kicad,
        'model': TabType.model,
        'pdf': TabType.pdf,
        'binary': TabType.binary,
        'custom': TabType.custom,
      };

      wireValues.forEach((wire, expected) {
        expect(TabType.fromString(wire), expected, reason: wire);
        expect(expected.wireName, wire, reason: wire);
        expect(expected.label, isNotEmpty, reason: wire);
      });
    });

    test('falls back to unknown, never to terminal', () {
      expect(TabType.fromString('something-lee-added-later'),
          TabType.unknown);
      expect(TabType.fromString(''), TabType.unknown);
    });
  });

  group('TabContext', () {
    TabContext parse(Map<String, dynamic> json) => TabContext.fromJson(json);

    test('an unknown type keeps its raw name and does not open a terminal',
        () {
      final tab = parse({
        'id': 9,
        'type': 'hologram',
        'label': 'Something new',
        'ptyId': null,
      });

      expect(tab.type, TabType.unknown);
      expect(tab.rawType, 'hologram');
      expect(tab.typeLabel, 'hologram');
      expect(tab.opensTerminal, isFalse);
    });

    test('viewer tabs have no PTY, so they never open the terminal view', () {
      for (final type in ['pdf', 'model', 'kicad', 'binary', 'files']) {
        final tab = parse({'id': 1, 'type': type, 'label': type});
        expect(tab.opensTerminal, isFalse, reason: type);
      }
    });

    test('a PTY-backed tab opens the terminal view whatever its type is', () {
      final tab = parse({
        'id': 4,
        'type': 'spyglass',
        'label': 'Spyglass',
        'ptyId': 12,
      });
      expect(tab.opensTerminal, isTrue);
    });

    test('accepts the snake_case pty_id alias', () {
      final tab = parse({
        'id': 5,
        'type': 'terminal',
        'label': 'Terminal',
        'pty_id': 7,
      });
      expect(tab.ptyId, 7);
      expect(tab.opensTerminal, isTrue);
    });

    test('agent tabs surface their provider in the type badge', () {
      final tab = parse({
        'id': 6,
        'type': 'agent',
        'label': 'Claude',
        'ptyId': 3,
        'provider': 'claude',
      });
      expect(tab.type, TabType.agent);
      expect(tab.provider, 'claude');
      expect(tab.typeLabel, 'Agent (claude)');
    });

    test('parses filePath/browserUrl defensively, camelCase or snake_case',
        () {
      final camel = parse({
        'id': 7,
        'type': 'pdf',
        'label': 'doc.pdf',
        'filePath': '/ws/doc.pdf',
      });
      expect(camel.filePath, '/ws/doc.pdf');

      final snake = parse({
        'id': 8,
        'type': 'browser',
        'label': 'tab',
        'browser_url': 'https://example.com',
      });
      expect(snake.browserUrl, 'https://example.com');

      final none = parse({'id': 9, 'type': 'pdf', 'label': 'doc.pdf'});
      expect(none.filePath, isNull);
    });
  });
}
