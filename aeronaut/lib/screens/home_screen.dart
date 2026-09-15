import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/lee_context.dart';
import '../models/machine.dart';
import '../providers/auth_provider.dart';
import '../providers/connection_provider.dart';
import '../providers/context_provider.dart';
import '../providers/machines_provider.dart';
import '../providers/windows_provider.dart';
import '../services/api_auth.dart';
import '../services/lee_api.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../widgets/auth_banner.dart';
import '../widgets/machine_switcher.dart';
import '../widgets/new_tab_sheet.dart';
import '../widgets/tab_bar.dart';
import '../widgets/workspace_switcher.dart';
import '../models/fs_entry.dart';
import '../services/fs_api.dart';
import 'browser_screen.dart';
import 'editor_screen.dart';
import 'files_screen.dart';
import 'hester_screen.dart';
import 'machine_detail_screen.dart';
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
    ref.watch(authGuardProvider);

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
          // Files browser — reachable even when no `files` tab is open.
          IconButton(
            icon: const Icon(Icons.folder_outlined, size: 20),
            tooltip: 'Files',
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const FilesScreen()),
            ),
          ),
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
          // Machine health / details
          IconButton(
            icon: const Icon(Icons.info_outline, size: 20),
            tooltip: 'Machine details',
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => MachineDetailScreen(machine: activeMachine),
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
            const AuthBanner(),
            // Tab strip
            contextAsync.when(
              data: (ctx) => LeeTabBar(
                tabs: ctx.tabs,
                activeTabId: ctx.activeTab?.id,
                onTabTap: (tab) => _focusTab(ref, activeMachine, tab),
              ),
              loading: () => const SizedBox(height: 44),
              error: (_, _) => const SizedBox(height: 44),
            ),
            const Divider(height: 1),
            // Content area
            Expanded(
              child: contextAsync.when(
                data: (ctx) => _TabContent(context: ctx),
                loading: () => connectionState.unauthorized
                    ? _ErrorView(
                        message: AuthFailure.message,
                        onRetry: () => ref
                            .read(connectionProvider.notifier)
                            .reconnect(),
                      )
                    : _ConnectingView(machineName: activeMachine.name),
                error: (error, _) => _ErrorView(
                  message: connectionState.unauthorized
                      ? AuthFailure.message
                      : error.toString(),
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
    final leeCtx = ref.read(leeContextProvider).valueOrNull;
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (_) => NewTabSheet(
        availableTuis: leeCtx?.availableTuis ?? const [],
      ),
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

    // Route by view type.
    //
    // The terminal (xterm) view is reserved for tabs Lee actually backed with
    // a PTY — checked via ptyId, not the type name, so viewer tabs added on
    // the Lee side (pdf, model, kicad, binary) and React panes (files,
    // library, workstream) never render as a blank terminal.
    if (tab.type.isEditorLike) {
      return EditorScreen(tab: tab);
    }
    if (tab.type == TabType.browser) {
      return BrowserScreen(tabId: tab.id, browserUrl: context.browsers?[tab.id]?.url);
    }
    if (tab.type == TabType.files) {
      // Embedded (no extra Scaffold/AppBar) — the Files icon in the app bar
      // pushes the full FilesScreen route so it's reachable without a
      // `files` tab open at all.
      return const FilesBrowserBody();
    }
    if (tab.opensTerminal) {
      return TerminalScreen(tab: tab);
    }
    if (tab.type.isAgentLike) {
      // An agent tab with no PTY is a chat we can hold over Hester's HTTP API.
      return HesterScreen(tab: tab);
    }
    return _GenericTabView(tab: tab);
  }
}

/// Read-only view for a tab Aeronaut has no richer screen for — including
/// tab types this build has never heard of. Shows the title, a type badge and
/// a Focus button, which is all the milestone asks of a viewer tab.
/// Tab types whose content is a file Lee opened, but whose path isn't
/// currently sent over the context stream (unlike editor-like tabs, whose
/// path comes from the real `context.editors` map — see `EditorScreen`).
/// `TabContext.filePath` is parsed defensively in case a future Lee build
/// adds it to the tab payload; when it's there, this view fetches size/mtime
/// via `/fs/read?stat=1` instead of just showing the type badge.
const _fileBackedNoWirePathTypes = {
  TabType.pdf,
  TabType.binary,
  TabType.kicad,
  TabType.model,
};

class _GenericTabView extends ConsumerWidget {
  final TabContext tab;

  const _GenericTabView({required this.tab});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final machine = ref.watch(machinesProvider).activeMachine;
    final isFileBacked = _fileBackedNoWirePathTypes.contains(tab.type);

    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(AeronautTheme.spacingXl),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              iconForTabType(tab.type),
              size: 48,
              color: AeronautColors.textTertiary,
            ),
            const SizedBox(height: AeronautTheme.spacingMd),
            Text(
              tab.label,
              textAlign: TextAlign.center,
              style: AeronautTheme.heading.copyWith(
                color: AeronautColors.textSecondary,
              ),
            ),
            const SizedBox(height: AeronautTheme.spacingSm),
            Container(
              padding: const EdgeInsets.symmetric(
                horizontal: AeronautTheme.spacingSm,
                vertical: 4,
              ),
              decoration: BoxDecoration(
                color: AeronautColors.bgElevated,
                borderRadius:
                    BorderRadius.circular(AeronautTheme.radiusSm),
                border: Border.all(color: AeronautColors.border),
              ),
              child: Text(
                tab.typeLabel.toUpperCase(),
                style: AeronautTheme.caption.copyWith(
                  fontSize: 10,
                  letterSpacing: 0.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            const SizedBox(height: AeronautTheme.spacingSm),
            if (isFileBacked && machine != null)
              _FileBackedMeta(tab: tab, machine: machine)
            else
              const Text(
                'This tab has no remote view. Focus it to bring it forward '
                'on the desktop.',
                textAlign: TextAlign.center,
                style: AeronautTheme.caption,
              ),
            const SizedBox(height: AeronautTheme.spacingLg),
            Wrap(
              spacing: AeronautTheme.spacingSm,
              alignment: WrapAlignment.center,
              children: [
                ElevatedButton.icon(
                  onPressed: machine == null
                      ? null
                      : () {
                          final windowId = ref.read(activeWindowIdProvider);
                          final api = LeeApi(machine: machine);
                          api
                              .sendCommand(
                                'system',
                                'focus_tab',
                                {'tab_id': tab.id},
                                windowId,
                              )
                              .whenComplete(api.dispose);
                        },
                  icon: const Icon(Icons.open_in_new, size: 16),
                  label: const Text('Focus'),
                ),
                if (isFileBacked)
                  OutlinedButton.icon(
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const FilesScreen(),
                      ),
                    ),
                    icon: const Icon(Icons.folder_outlined, size: 16),
                    label: const Text('Browse Files'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Metadata for a file-backed tab whose path isn't on the wire yet.
///
/// When `tab.filePath` is present (a future Lee build, or a client that set
/// it), fetches `/fs/read?stat=1` and shows path/size/mtime. Otherwise
/// explains the gap plainly instead of pretending to know the path — see
/// `aeronaut/CLAUDE.md`'s "Tab type support" section for why this can't be
/// filled in from this build's read-only endpoints alone.
class _FileBackedMeta extends StatefulWidget {
  final TabContext tab;
  final Machine machine;

  const _FileBackedMeta({required this.tab, required this.machine});

  @override
  State<_FileBackedMeta> createState() => _FileBackedMetaState();
}

class _FileBackedMetaState extends State<_FileBackedMeta> {
  FsReadResult? _stat;
  String? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    final path = widget.tab.filePath;
    if (path != null && path.isNotEmpty) {
      _loadStat(path);
    }
  }

  Future<void> _loadStat(String path) async {
    setState(() => _loading = true);
    final api = FsApi(machine: widget.machine);
    try {
      final result = await api.readFile(path, statOnly: true);
      if (!mounted) return;
      setState(() {
        _stat = result;
        _loading = false;
      });
    } on FsApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    } finally {
      api.dispose();
    }
  }

  @override
  Widget build(BuildContext context) {
    final path = widget.tab.filePath;
    if (path == null || path.isEmpty) {
      return const Text(
        "Lee doesn't report this tab's file path over the context stream "
        'yet, so there\'s nothing to fetch here. Browse to the file below, '
        'or Focus this tab on the desktop.',
        textAlign: TextAlign.center,
        style: AeronautTheme.caption,
      );
    }
    if (_loading) {
      return const SizedBox(
        height: 20,
        width: 20,
        child: CircularProgressIndicator(
          color: AeronautColors.accent,
          strokeWidth: 2,
        ),
      );
    }
    if (_error != null) {
      return Text(
        _error!,
        textAlign: TextAlign.center,
        style: AeronautTheme.caption,
      );
    }
    final stat = _stat;
    if (stat == null) return const SizedBox.shrink();
    return Column(
      children: [
        Text(
          stat.path,
          textAlign: TextAlign.center,
          style: AeronautTheme.mono.copyWith(fontSize: 11),
        ),
        const SizedBox(height: 4),
        Text(
          '${_formatBytes(stat.size)} · ${stat.mime}',
          style: AeronautTheme.caption.copyWith(fontSize: 11),
        ),
      ],
    );
  }
}

String _formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(2)} MB';
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
