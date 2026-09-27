import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:aeronaut/providers/machines_provider.dart';
import 'package:aeronaut/screens/machines_screen.dart';
import 'package:aeronaut/screens/root_shell.dart';
import 'package:aeronaut/services/machine_store.dart';
import 'package:aeronaut/theme/aeronaut_theme.dart';

/// No saved machines, and no SharedPreferences or health pings.
class _EmptyMachinesNotifier extends MachinesNotifier {
  _EmptyMachinesNotifier() : super(MachineStore());
}

void main() {
  testWidgets('four tabs, Work first; Machine holds the machine list until one is chosen', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [machinesProvider.overrideWith((ref) => _EmptyMachinesNotifier())],
        child: MaterialApp(theme: AeronautTheme.darkTheme, home: const RootShell()),
      ),
    );
    await tester.pump();

    expect(RootTab.values, [RootTab.work, RootTab.library, RootTab.hester, RootTab.machine]);
    final labels = ['Work', 'Library', 'Hester', 'Machine'];
    for (final l in labels) {
      expect(find.text(l), findsWidgets);
    }
    final xs = [for (final l in labels) tester.getTopLeft(find.text(l).last).dx];
    expect(xs, [...xs]..sort(), reason: 'in tab-bar order');

    // With no machine, the shell opens on Machine, which lists machines.
    expect(find.byType(MachinesScreen), findsOneWidget);

    // Work without a machine sends you to Machine.
    await tester.tap(find.text('Work').last);
    await tester.pump();
    expect(find.text('No machine selected'), findsOneWidget);
    await tester.tap(find.text('Choose a machine'));
    await tester.pump();
    final container = ProviderScope.containerOf(tester.element(find.byType(RootShell)));
    expect(container.read(rootTabProvider), RootTab.machine);
  });
}
