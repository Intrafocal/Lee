import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show HapticFeedback;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/attention.dart';
import '../models/hester_models.dart';
import '../providers/attention_provider.dart';
import '../providers/hester_provider.dart';
import '../providers/machines_provider.dart';
import '../services/app_group.dart';
import '../providers/speech_provider.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import '../widgets/phosphor_icon.dart';
import '../widgets/send_to_lee_sheet.dart';
import '../widgets/speaker_toggle.dart';
import 'hester_screen.dart';
import 'home_screen.dart';
import 'machines_screen.dart';
import 'review_screen.dart';
import 'work_screen.dart';

/// The top-level destinations, in tab-bar order: Work · Review · Hester
/// (docs/plans/2026-09-28-tether-review-voice.md §3.1), then Machine.
/// [work] leads: it's where Pick up, replies, capture and Send to Lee live,
/// and it's the default once a machine is selected — see [_RootShellState].
/// [review] reads the Desk, the Drawer and Files. [machine] holds the
/// machine switcher and that machine's tabs (each opens in Compose).
enum RootTab { work, review, hester, machine }

/// Which root tab is showing. Screens switch tabs by writing to this, e.g.
/// connecting to a machine jumps to [RootTab.work].
final rootTabProvider = StateProvider<RootTab>((ref) => RootTab.machine);

/// App shell: a Cupertino tab bar over four independent navigation stacks,
/// so pushing a file in Machine doesn't disturb Work and each tab keeps its
/// own back history.
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
  bool _readbackBaseline = false;
  Set<String> _readbackSeen = {};

  static Widget _rootFor(RootTab tab) => switch (tab) {
        RootTab.work => const RequireMachine(child: WorkScreen()),
        RootTab.review => const RequireMachine(child: ReviewScreen()),
        RootTab.hester => const RequireMachine(child: _HesterRoot()),
        RootTab.machine => const _MachineRoot(),
      };

  @override
  void initState() {
    super.initState();
    // Work becomes the default tab once a machine is selected — whether that
    // happens at startup (a machine was already active on disk) or when the
    // user connects from the machine list. Only fires on the null→non-null
    // edge, so it never yanks the user off a tab they picked by hand later.
    ref.listenManual<MachinesState>(machinesProvider, (prev, next) {
      if (prev?.activeMachineId == null && next.activeMachineId != null) {
        ref.read(rootTabProvider.notifier).state = RootTab.work;
      }
    });
    // Contracts §9.2: banner + haptic the moment an item's `notify` flips
    // true, wherever the user currently is in the app — not just when
    // they're already looking at Work.
    _notifyRoseSub = ref.read(attentionProvider.notifier).notifyRoseStream.listen(_onNotifyRose);
    _listenForReadback();
    // The share extension sends to whichever Machine is active here.
    ref.listenManual<MachinesState>(machinesProvider, (prev, next) {
      final m = next.activeMachine;
      final was = prev?.activeMachine;
      if (prev == null || m?.id != was?.id || m?.token != was?.token || m?.host != was?.host || m?.hostPort != was?.hostPort || m?.workspace != was?.workspace) {
        AppGroup.publishMachine(m);
      }
    }, fireImmediately: true);
  }

  /// Readback (§5.5): Hester's final answers, and new items from agents
  /// you replied to by voice. [SpeechNotifier] checks the toggle and that
  /// the app is in front.
  void _listenForReadback() {
    ref.listenManual<HesterChatState>(hesterChatProvider, (prev, next) {
      if (prev == null || !prev.isStreaming || next.isStreaming) return;
      // A stream that ended on an error leaves your question last: nothing to read.
      if (next.messages.isEmpty || !next.messages.last.isAssistant) return;
      ref.read(speechProvider.notifier).readHesterAnswer(next.messages.last.content);
    });
    ref.listenManual<AttentionUiState>(attentionProvider, (prev, next) {
      final ids = {for (final i in next.snapshot.items) i.id};
      // The first loaded snapshot is a baseline, not news.
      if (!_readbackBaseline) {
        if (!next.loading) _readbackBaseline = true;
        _readbackSeen = ids;
        return;
      }
      for (final item in next.snapshot.items) {
        if (!_readbackSeen.contains(item.id) && item.state == AttentionItemState.open) {
          ref.read(speechProvider.notifier).readAttentionItem(item);
        }
      }
      _readbackSeen = ids;
    });
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
        leading: const PhosphorIcon(PhosphorIcons.bell, size: 20, color: AeronautColors.warning),
        content: Text(item.title.isEmpty ? 'Lee needs you' : item.title),
        actions: [
          TextButton(
            onPressed: () {
              messenger.hideCurrentMaterialBanner();
              ref.read(rootTabProvider.notifier).state = RootTab.work;
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
        // Active nav is never phosphor (cockpit design §0 rule 1): the
        // selected tab is primary text, the rest muted.
        bottomNavigationBar: CupertinoTabBar(
          currentIndex: current.index,
          onTap: (i) => _select(RootTab.values[i]),
          activeColor: AeronautColors.textPrimary,
          inactiveColor: AeronautColors.textTertiary,
          backgroundColor: AeronautColors.chrome,
          border: const Border(
            top: BorderSide(color: AeronautColors.border, width: 0.5),
          ),
          items: [
            _item(PhosphorIcons.bell, 'Work', current == RootTab.work),
            _item(PhosphorIcons.book, 'Review', current == RootTab.review),
            _item(PhosphorIcons.hester, 'Hester', current == RootTab.hester),
            _item(PhosphorIcons.machine, 'Machine', current == RootTab.machine),
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
        color: active ? AeronautColors.textPrimary : AeronautColors.textTertiary,
      ),
      label: label,
    );
  }
}

/// The Machine tab: the saved machines until one is chosen, then that
/// machine's tabs (with the switcher in the app bar).
class _MachineRoot extends ConsumerWidget {
  const _MachineRoot();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hasMachine = ref.watch(
      machinesProvider.select((s) => s.activeMachine != null),
    );
    return hasMachine ? const HomeScreen() : const MachinesScreen();
  }
}

/// Hester as a root tab: HesterScreen is a body, so it gets its own bar,
/// with Send to Lee and Speak replies.
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
        actions: const [SendToLeeButton(), SpeakerToggle()],
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
                'Pick a Lee instance in Machine to see its work, the Desk and Hester.',
                textAlign: TextAlign.center,
                style: AeronautTheme.subheadline.copyWith(
                  color: AeronautColors.textTertiary,
                ),
              ),
              const SizedBox(height: AeronautTheme.spacingLg),
              ElevatedButton(
                onPressed: () => ref.read(rootTabProvider.notifier).state =
                    RootTab.machine,
                child: const Text('Choose a machine'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
