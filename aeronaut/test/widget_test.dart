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
      final machine = Machine(
        id: '1',
        name: 'Test',
        host: '192.168.1.100',
        hostPort: 9001,
      );
      expect(machine.hostUrl, 'http://192.168.1.100:9001');
    });

    test('computes contextStreamUrl correctly', () {
      final machine = Machine(
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
  });
}
