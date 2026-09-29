import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:aeronaut/models/fs_entry.dart';
import 'package:aeronaut/models/machine.dart';
import 'package:aeronaut/providers/machines_provider.dart';
import 'package:aeronaut/screens/files_screen.dart';
import 'package:aeronaut/services/fs_api.dart';
import 'package:aeronaut/services/machine_store.dart';
import 'package:aeronaut/theme/aeronaut_theme.dart';

const _machine = Machine(id: 'm1', name: 'Dev', host: '127.0.0.1', token: 't');

/// Puts [_machine] in place as the active machine without touching
/// SharedPreferences — same pattern as `someday_screen_test.dart`.
class _FixedMachinesNotifier extends MachinesNotifier {
  _FixedMachinesNotifier() : super(MachineStore()) {
    state = const MachinesState(machines: [_machine], activeMachineId: 'm1');
  }
}

/// A tiny in-memory filesystem for `GET /fs/list`, keyed by absolute path —
/// a nested-directory fixture standing in for Lee's real endpoint so the
/// browser's expand-a-folder path can be exercised without a network call.
FsListResult _dir(String path, List<FsEntryInfo> entries) =>
    FsListResult(path: path, entries: entries);

Future<void> _pumpFilesScreen(
  WidgetTester tester,
  Future<FsListResult> Function(Machine machine, String path) listDir,
) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        machinesProvider.overrideWith((ref) => _FixedMachinesNotifier()),
        workspaceRootProvider.overrideWithValue('/repo'),
      ],
      child: MaterialApp(
        theme: AeronautTheme.darkTheme,
        home: FilesScreen(listDir: listDir),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  // Root: one subfolder ("sub") and one file ("readme.txt"). "sub" itself
  // contains one nested file ("nested.txt") — the case that was rendering
  // as blank rows instead of the real names.
  final fixture = <String, FsListResult>{
    '/repo': _dir('/repo', const [
      FsEntryInfo(name: 'sub', type: 'dir', size: 0, mtimeMs: 0),
      FsEntryInfo(name: 'readme.txt', type: 'file', size: 42, mtimeMs: 0),
    ]),
    '/repo/sub': _dir('/repo/sub', const [
      FsEntryInfo(name: 'nested.txt', type: 'file', size: 7, mtimeMs: 0),
    ]),
  };

  Future<FsListResult> fakeListDir(Machine machine, String path) async {
    final result = fixture[path];
    if (result == null) {
      throw FsApiException(FsErrorKind.notFound, 'no fixture for $path');
    }
    return result;
  }

  testWidgets('root listing shows folder and file names', (tester) async {
    await _pumpFilesScreen(tester, fakeListDir);

    expect(find.text('sub'), findsOneWidget);
    expect(find.text('readme.txt'), findsOneWidget);
  });

  testWidgets('expanding a folder shows its real contents, not blank rows', (tester) async {
    await _pumpFilesScreen(tester, fakeListDir);

    // Before expanding, the nested file must not appear at all.
    expect(find.text('nested.txt'), findsNothing);

    await tester.tap(find.text('sub'));
    await tester.pumpAndSettle();

    // The regression this guards: the nested tile used to render with no
    // visible name. Assert the actual text is present (not just "some
    // tile exists"), and that there is exactly one row with real content.
    expect(find.text('nested.txt'), findsOneWidget);

    // No blank-looking ListTile in place of it: every visible ListTile has
    // non-empty title text.
    final tiles = tester.widgetList<ListTile>(find.byType(ListTile));
    for (final tile in tiles) {
      final title = tile.title;
      expect(title, isA<Text>());
      expect((title! as Text).data, isNotNull);
      expect((title as Text).data!.trim(), isNotEmpty);
    }
  });

  testWidgets('re-collapsing and re-expanding still shows the same contents', (tester) async {
    await _pumpFilesScreen(tester, fakeListDir);

    await tester.tap(find.text('sub'));
    await tester.pumpAndSettle();
    expect(find.text('nested.txt'), findsOneWidget);

    await tester.tap(find.text('sub'));
    await tester.pumpAndSettle();
    expect(find.text('nested.txt'), findsNothing);

    await tester.tap(find.text('sub'));
    await tester.pumpAndSettle();
    expect(find.text('nested.txt'), findsOneWidget);
  });
}
