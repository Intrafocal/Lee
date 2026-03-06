import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/lee_context.dart';
import '../models/machine.dart';
import '../providers/connection_provider.dart';
import '../providers/context_provider.dart';
import '../providers/machines_provider.dart';
import '../providers/windows_provider.dart';
import '../services/lee_api.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../widgets/machine_switcher.dart';
import '../widgets/new_tab_sheet.dart';
import '../widgets/tab_bar.dart';
import '../widgets/workspace_switcher.dart';
import 'browser_screen.dart';
import 'editor_screen.dart';
import 'hester_screen.dart';
import 'machines_screen.dart';
import 'terminal_screen.dart';

/// Main screen shown when connected to a machine.
///
/// Displays the machine name, tab strip from LeeContext, and
/// tab-type-appropriate content for the active tab.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final machinesState = ref.watch(machinesProvider);
    final connectionState = ref.watch(connectionProvider);
    final contextAsync = ref.watch(leeContextProvider);

    final activeMachine = machinesState.activeMachine;
    if (activeMachine == null) {
      // No machine selected — go back to machines list
      WidgetsBinding.instance.addPostFrameCallback((_) {
        Navigator.of(context).pushReplacement(
          MaterialPageRoute<void>(builder: (_) => const MachinesScreen()),
        );
      });
      return const SizedBox.shrink();
    }

    final windowsState = ref.watch(windowsProvider);

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            const MachineSwitcher(),
            if (windowsState.hasMultipleWindows)
              const WorkspaceSwitcher(),
          ],
        ),
        leading: IconButton(
          icon: const Icon(Icons.dns_outlined),
          tooltip: 'Machines',
          onPressed: () {
            Navigator.of(context).pushReplacement(
              MaterialPageRoute<void>(
                builder: (_) => const MachinesScreen(),
              ),
            );
          },
        ),
        actions: [
          // Hester chat
          IconButton(
            icon: const Icon(Icons.cruelty_free, size: 20),
            tooltip: 'Hester',
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => Scaffold(
                  appBar: AppBar(title: const Text('Hester')),
                  body: const HesterScreen(),
                ),
              ),
            ),
          ),
          // New tab button
          IconButton(
            icon: const Icon(Icons.add),
            tooltip: 'New tab',
            onPressed: () => _showNewTabSheet(context, ref, activeMachine),
          ),
          // Connection status indicator
          Padding(
            padding: const EdgeInsets.only(right: AeronautTheme.spacingMd),
            child: _ConnectionDot(status: connectionState.status),
          ),
        ],
      ),
      body: RefreshIndicator(
        color: AeronautColors.accent,
        backgroundColor: AeronautColors.bgSurface,
        onRefresh: () => _refreshContext(ref, activeMachine),
        child: Column(
          children: [
            // Tab strip
            contextAsync.when(
              data: (ctx) => LeeTabBar(
                tabs: ctx.tabs,
                activeTabId: ctx.activeTab?.id,
                onTabTap: (tab) => _focusTab(ref, activeMachine, tab),
              ),
              loading: () => const SizedBox(height: 44),
              error: (_, __) => const SizedBox(height: 44),
            ),
            const Divider(height: 1),
            // Content area
            Expanded(
              child: contextAsync.when(
                data: (ctx) => _TabContent(context: ctx),
                loading: () => _ConnectingView(
                  machineName: activeMachine.name,
                ),
                error: (error, _) => _ErrorView(
                  message: error.toString(),
                  onRetry: () =>
                      ref.read(connectionProvider.notifier).reconnect(),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _refreshContext(WidgetRef ref, Machine machine) async {
    final api = LeeApi(machine: machine);
    try {
      await api.getContext();
      // The WebSocket connection will push the fresh context automatically,
      // but triggering a GET /context ensures it's up to date.
      ref.read(connectionProvider.notifier).reconnect();
    } finally {
      api.dispose();
    }
  }

  void _focusTab(WidgetRef ref, Machine machine, TabContext tab) {
    final windowId = ref.read(activeWindowIdProvider);
    final api = LeeApi(machine: machine);
    api
        .sendCommand('system', 'focus_tab', {'tab_id': tab.id}, windowId)
        .then((_) {
      api.dispose();
    });
  }

  void _showNewTabSheet(
    BuildContext context,
    WidgetRef ref,
    Machine machine,
  ) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (_) => const NewTabSheet(),
    );

    if (action != null) {
      final windowId = ref.read(activeWindowIdProvider);
      final api = LeeApi(machine: machine);
      await api.sendCommand('tui', action, {}, windowId);
      api.dispose();
    }
  }
}

/// Shows content appropriate for the active tab type.
class _TabContent extends StatelessWidget {
  final LeeContext context;

  const _TabContent({required this.context});

  @override
  Widget build(BuildContext context2) {
    final tab = context.activeTab;
    if (tab == null) {
      return Center(
        child: Text(
          'No active tab',
          style: AeronautTheme.body.copyWith(
            color: AeronautColors.textTertiary,
          ),
        ),
      );
    }

    // Route by view type
    switch (tab.type) {
      case TabType.editor:
        return const EditorScreen();

      case TabType.browser:
        return BrowserScreen(tabId: tab.id);

      case TabType.hester:
      case TabType.hesterQa:
      case TabType.claude:
        // Hester/Claude with PTY → terminal view; without → placeholder
        if (tab.ptyId != null) {
          return TerminalScreen(tab: tab);
        }
        return HesterScreen(tab: tab);

      default:
        // Everything with a PTY → terminal screen
        if (tab.ptyId != null) {
          return TerminalScreen(tab: tab);
        }
        return _GenericTabView(tab: tab);
    }
  }
}

class _GenericTabView extends StatelessWidget {
  final TabContext tab;

  const _GenericTabView({required this.tab});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.tab,
            size: 48,
            color: AeronautColors.textTertiary,
          ),
          const SizedBox(height: AeronautTheme.spacingMd),
          Text(
            tab.label,
            style: AeronautTheme.heading.copyWith(
              color: AeronautColors.textSecondary,
            ),
          ),
          const SizedBox(height: AeronautTheme.spacingSm),
          Text(
            '${tab.type.name} tab',
            style: AeronautTheme.caption,
          ),
        ],
      ),
    );
  }
}

class _ConnectingView extends StatelessWidget {
  final String machineName;

  const _ConnectingView({required this.machineName});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const CircularProgressIndicator(
            color: AeronautColors.accent,
            strokeWidth: 2,
          ),
          const SizedBox(height: AeronautTheme.spacingLg),
          Text(
            'Connecting to $machineName...',
            style: AeronautTheme.body.copyWith(
              color: AeronautColors.textSecondary,
            ),
          ),
        ],
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _ErrorView({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AeronautTheme.spacingXl),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(
              Icons.error_outline,
              size: 48,
              color: AeronautColors.offline,
            ),
            const SizedBox(height: AeronautTheme.spacingMd),
            Text(
              'Connection failed',
              style: AeronautTheme.heading.copyWith(
                color: AeronautColors.textSecondary,
              ),
            ),
            const SizedBox(height: AeronautTheme.spacingSm),
            Text(
              message,
              textAlign: TextAlign.center,
              style: AeronautTheme.caption,
            ),
            const SizedBox(height: AeronautTheme.spacingLg),
            ElevatedButton(
              onPressed: onRetry,
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
    );
  }
}

class _ConnectionDot extends StatelessWidget {
  final ConnectionStatus status;

  const _ConnectionDot({required this.status});

  @override
  Widget build(BuildContext context) {
    final Color color;
    switch (status) {
      case ConnectionStatus.connected:
        color = AeronautColors.online;
        break;
      case ConnectionStatus.connecting:
        color = AeronautColors.warning;
        break;
      case ConnectionStatus.error:
        color = AeronautColors.offline;
        break;
      case ConnectionStatus.disconnected:
        color = AeronautColors.textTertiary;
        break;
    }

    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color,
      ),
    );
  }
}
