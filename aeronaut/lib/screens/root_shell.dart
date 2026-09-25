import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show HapticFeedback;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/attention.dart';
import '../providers/attention_provider.dart';
import '../providers/machines_provider.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import '../widgets/phosphor_icon.dart';
import 'files_screen.dart';
import 'hester_screen.dart';
import 'home_screen.dart';
import 'machines_screen.dart';
import 'now_screen.dart';

/// The five top-level destinations, in tab-bar order. [now] leads: it's
/// where Copilot's Reply/Capture/Focus/Launch/Wins live (contracts §9.2),
/// and it's the default once a machine is selected — see [_RootShellState].
enum RootTab { now, machines, tabs, hester, files }

/// Which root tab is showing. Screens switch tabs by writing to this, e.g.
/// connecting to a machine jumps to [RootTab.now].
final rootTabProvider = StateProvider<RootTab>((ref) => RootTab.machines);

/// App shell: a Cupertino tab bar over five independent navigation stacks,
/// so pushing a file in Files doesn't disturb the Tabs view and each tab
/// keeps its own back history.
class RootShell extends ConsumerStatefulWidget {
  const RootShell({super.key});

  @override
  ConsumerState<RootShell> createState() => _RootShellState();
}

class _RootShellState extends ConsumerState<RootShell> {
  final _navigatorKeys = {
    for (final tab in RootTab.values) tab: GlobalKey<NavigatorState>(),
  };
  StreamSubscription<AttentionItem>? _notifyRoseSub;

  static Widget _rootFor(RootTab tab) => switch (tab) {
        RootTab.now => const RequireMachine(child: NowScreen()),
        RootTab.machines => const MachinesScreen(),
        RootTab.tabs => const RequireMachine(child: HomeScreen()),
        RootTab.hester => const RequireMachine(child: _HesterRoot()),
        RootTab.files => const RequireMachine(child: FilesScreen()),
      };

  @override
  void initState() {
    super.initState();
    // Now becomes the default tab once a machine is selected — whether that
    // happens at startup (a machine was already active on disk) or when the
    // user connects from the Machines tab. Only fires on the null→non-null
    // edge, so it never yanks the user off a tab they picked by hand later.
    ref.listenManual<MachinesState>(machinesProvider, (prev, next) {
      if (prev?.activeMachineId == null && next.activeMachineId != null) {
        ref.read(rootTabProvider.notifier).state = RootTab.now;
      }
    });
    // Contracts §9.2: banner + haptic the moment an item's `notify` flips
    // true, wherever the user currently is in the app — not just when
    // they're already looking at Now.
    _notifyRoseSub = ref.read(attentionProvider.notifier).notifyRoseStream.listen(_onNotifyRose);
  }

  @override
  void dispose() {
    _notifyRoseSub?.cancel();
    super.dispose();
  }

  void _onNotifyRose(AttentionItem item) {
    if (!mounted) return;
    HapticFeedback.heavyImpact();
    final messenger = ScaffoldMessenger.of(context);
    messenger.hideCurrentMaterialBanner();
    messenger.showMaterialBanner(
      MaterialBanner(
        backgroundColor: AeronautColors.bgSurface,
        contentTextStyle: AeronautTheme.subheadline.copyWith(color: AeronautColors.textPrimary),
        leading: const PhosphorIcon(PhosphorIcons.bell, size: 20, color: AeronautColors.accent),
        content: Text(item.title.isEmpty ? 'Lee needs you' : item.title),
        actions: [
          TextButton(
            onPressed: () {
              messenger.hideCurrentMaterialBanner();
              ref.read(rootTabProvider.notifier).state = RootTab.now;
            },
            child: const Text('View'),
          ),
          TextButton(
            onPressed: messenger.hideCurrentMaterialBanner,
            child: const Text('Dismiss'),
          ),
        ],
      ),
    );
  }

  void _select(RootTab tab) {
    final current = ref.read(rootTabProvider);
    if (tab == current) {
      // Re-tapping the active tab pops back to its root, as on iOS.
      _navigatorKeys[tab]!.currentState?.popUntil((r) => r.isFirst);
      return;
    }
    ref.read(rootTabProvider.notifier).state = tab;
  }

  @override
  Widget build(BuildContext context) {
    final current = ref.watch(rootTabProvider);

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        _navigatorKeys[current]!.currentState?.maybePop();
      },
      child: Scaffold(
        body: IndexedStack(
          index: current.index,
          children: [
            for (final tab in RootTab.values)
              HeroControllerScope.none(
                child: Navigator(
                  key: _navigatorKeys[tab],
                  onGenerateRoute: (_) => CupertinoPageRoute<void>(
                    builder: (_) => _rootFor(tab),
                  ),
                ),
              ),
          ],
        ),
        bottomNavigationBar: CupertinoTabBar(
          currentIndex: current.index,
          onTap: (i) => _select(RootTab.values[i]),
          activeColor: AeronautColors.accent,
          inactiveColor: AeronautColors.textTertiary,
          backgroundColor: AeronautColors.chrome,
          border: const Border(
            top: BorderSide(color: AeronautColors.border, width: 0.5),
          ),
          items: [
            _item(PhosphorIcons.bell, 'Now', current == RootTab.now),
            _item(PhosphorIcons.machine, 'Machines', current == RootTab.machines),
            _item(PhosphorIcons.tabs, 'Tabs', current == RootTab.tabs),
            _item(PhosphorIcons.hester, 'Hester', current == RootTab.hester),
            _item(PhosphorIcons.folder, 'Files', current == RootTab.files),
          ],
        ),
      ),
    );
  }

  BottomNavigationBarItem _item(PhosphorIconData icon, String label, bool active) {
    return BottomNavigationBarItem(
      icon: PhosphorIcon(
        icon,
        size: 24,
        color: active ? AeronautColors.accent : AeronautColors.textTertiary,
      ),
      label: label,
    );
  }
}

/// Hester as a root tab: HesterScreen is a body, so it gets its own bar.
class _HesterRoot extends StatelessWidget {
  const _HesterRoot();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            PhosphorIcon(PhosphorIcons.hester, size: 18, color: AeronautColors.accent),
            SizedBox(width: 8),
            Text('Hester'),
          ],
        ),
      ),
      body: const HesterScreen(),
    );
  }
}

/// Shows [child] once a machine is selected; otherwise a prompt that sends
/// the user to the Machines tab.
class RequireMachine extends ConsumerWidget {
  final Widget child;

  const RequireMachine({required this.child, super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hasMachine = ref.watch(
      machinesProvider.select((s) => s.activeMachine != null),
    );
    if (hasMachine) return child;

    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(AeronautTheme.spacingXl),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const PhosphorIcon(
                PhosphorIcons.machine,
                size: 48,
                color: AeronautColors.textTertiary,
              ),
              const SizedBox(height: AeronautTheme.spacingMd),
              Text(
                'No machine selected',
                style: AeronautTheme.headline.copyWith(
                  color: AeronautColors.textSecondary,
                ),
              ),
              const SizedBox(height: AeronautTheme.spacingSm),
              Text(
                'Pick a Lee instance to see its tabs, files and Hester.',
                textAlign: TextAlign.center,
                style: AeronautTheme.subheadline.copyWith(
                  color: AeronautColors.textTertiary,
                ),
              ),
              const SizedBox(height: AeronautTheme.spacingLg),
              ElevatedButton(
                onPressed: () => ref.read(rootTabProvider.notifier).state =
                    RootTab.machines,
                child: const Text('Choose a machine'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
