import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/hester_models.dart';
import '../models/machine.dart';
import '../providers/machines_provider.dart';
import '../services/hester_api.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import '../widgets/phosphor_icon.dart';

/// Someday list: open ideas captured via `CaptureSheet`
/// (`widgets/now_header_actions.dart`), reached from its "Someday" link.
///
/// Newest first (the daemon's `GET /someday` already sorts that way —
/// contracts, `hester/daemon/copilot/someday.py`). Touch-only triage per
/// docs/13-Copilot.md §5.2 ("the phone is bad at typing"): Explore, Promote,
/// Keep, Drop buttons, no text entry. Refreshes after every triage and on
/// pull-to-refresh.
class SomedayScreen extends ConsumerStatefulWidget {
  final String? workspace;

  /// Test seam: build the [HesterApi] used for a given [Machine]. Defaults
  /// to a plain `HesterApi(machine: machine)`; tests override this to
  /// inject a mock `http.Client`.
  final HesterApi Function(Machine machine)? apiBuilder;

  const SomedayScreen({required this.workspace, this.apiBuilder, super.key});

  @override
  ConsumerState<SomedayScreen> createState() => _SomedayScreenState();
}

class _SomedayScreenState extends ConsumerState<SomedayScreen> {
  List<SomedayItem> _items = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    if (widget.workspace != null) {
      _load();
    } else {
      _loading = false;
    }
  }

  HesterApi _api(Machine machine) => (widget.apiBuilder ?? (m) => HesterApi(machine: m))(machine);

  Future<void> _load() async {
    final workspace = widget.workspace;
    if (workspace == null) return;
    final machine = ref.read(machinesProvider).activeMachine;
    if (machine == null) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'No active machine';
      });
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    final api = _api(machine);
    try {
      final items = await api.getSomeday(workspace: workspace);
      if (!mounted) return;
      setState(() {
        _loading = false;
        if (items == null) {
          _error = 'Hester offline';
        } else {
          _items = items;
        }
      });
    } finally {
      api.dispose();
    }
  }

  Future<void> _triage(SomedayItem item, String action) async {
    final workspace = widget.workspace;
    if (workspace == null) return;
    final machine = ref.read(machinesProvider).activeMachine;
    if (machine == null) return;
    final messenger = ScaffoldMessenger.of(context);
    final api = _api(machine);
    try {
      final result = await api.triageSomeday(item.id, workspace: workspace, action: action);
      if (result == null && mounted) {
        messenger.showSnackBar(const SnackBar(content: Text('Triage failed — try again.')));
      }
    } finally {
      api.dispose();
    }
    // Same convention as AttentionTile's actions: reload from the server
    // rather than optimistically removing the row.
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Someday')),
      body: widget.workspace == null
          ? const Center(
              child: Text('No workspace selected.', style: AeronautTheme.caption1),
            )
          : RefreshIndicator.adaptive(
              color: AeronautColors.accent,
              backgroundColor: AeronautColors.bgSurface,
              onRefresh: _load,
              child: _buildBody(),
            ),
    );
  }

  Widget _buildBody() {
    if (_loading && _items.isEmpty && _error == null) {
      return const Center(child: CircularProgressIndicator.adaptive());
    }
    if (_error != null && _items.isEmpty) {
      return ListView(
        children: [
          SizedBox(
            height: MediaQuery.of(context).size.height * 0.6,
            child: Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const PhosphorIcon(PhosphorIcons.warning, size: 48, color: AeronautColors.offline),
                  const SizedBox(height: AeronautTheme.spacingMd),
                  Text(_error!, style: AeronautTheme.caption1),
                ],
              ),
            ),
          ),
        ],
      );
    }
    if (_items.isEmpty) {
      return ListView(
        children: [
          SizedBox(
            height: MediaQuery.of(context).size.height * 0.6,
            child: const Center(
              child: Text('Nothing captured yet.', style: AeronautTheme.caption1),
            ),
          ),
        ],
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: AeronautTheme.spacingSm),
      itemCount: _items.length,
      itemBuilder: (context, index) {
        final item = _items[index];
        return _SomedayTile(
          key: ValueKey('someday-${item.id}'),
          item: item,
          onTriage: (action) => _triage(item, action),
        );
      },
    );
  }
}

String _sourceLabel(String surface) {
  switch (surface) {
    case 'lee':
      return 'Lee';
    case 'aeronaut':
      return 'Aeronaut';
    case 'dirigible':
      return 'Dirigible';
    case 'device':
      return 'Device';
    case 'cli':
      return 'CLI';
    default:
      return 'Shared';
  }
}

/// `Xs` / `Xm` / `Xh` / `Xd` — same small-label convention as
/// `attention_tile.dart`'s `_age` (no `intl` dependency for one label).
String _age(DateTime? createdAt) {
  if (createdAt == null) return '';
  final diff = DateTime.now().toUtc().difference(createdAt.toUtc());
  if (diff.inSeconds < 60) return '${diff.inSeconds}s';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m';
  if (diff.inHours < 24) return '${diff.inHours}h';
  return '${diff.inDays}d';
}

class _SomedayTile extends StatefulWidget {
  final SomedayItem item;
  final Future<void> Function(String action) onTriage;

  const _SomedayTile({required this.item, required this.onTriage, super.key});

  @override
  State<_SomedayTile> createState() => _SomedayTileState();
}

class _SomedayTileState extends State<_SomedayTile> {
  bool _expanded = false;
  bool _busy = false;

  Future<void> _run(String action) async {
    if (_busy) return;
    setState(() => _busy = true);
    await widget.onTriage(action);
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    return Container(
      margin: const EdgeInsets.symmetric(
        horizontal: AeronautTheme.spacingMd,
        vertical: AeronautTheme.spacingXs,
      ),
      padding: const EdgeInsets.all(AeronautTheme.spacingMd),
      decoration: BoxDecoration(
        color: AeronautColors.bgSurface,
        borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
        border: Border.all(color: AeronautColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => setState(() => _expanded = !_expanded),
            child: Text(
              item.text,
              style: AeronautTheme.footnote,
              maxLines: _expanded ? null : 3,
              overflow: _expanded ? TextOverflow.visible : TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(height: AeronautTheme.spacingXs),
          Row(
            children: [
              Text(
                _sourceLabel(item.sourceSurface),
                style: AeronautTheme.caption2.copyWith(color: AeronautColors.textTertiary),
              ),
              const SizedBox(width: 8),
              Text(
                _age(item.createdAt),
                style: AeronautTheme.caption2.copyWith(color: AeronautColors.textTertiary),
              ),
              if (item.asExploration) ...[
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(
                    color: AeronautColors.accent.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(AeronautTheme.radiusSm),
                  ),
                  child: Text(
                    'as exploration',
                    style: AeronautTheme.caption2.copyWith(color: AeronautColors.accent),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: AeronautTheme.spacingSm),
          Wrap(
            spacing: AeronautTheme.spacingSm,
            runSpacing: 4,
            children: [
              _TriageButton(
                icon: PhosphorIcons.search,
                label: 'Explore',
                busy: _busy,
                onTap: () => _run('explore'),
              ),
              _TriageButton(
                icon: PhosphorIcons.chevronUp,
                label: 'Promote',
                busy: _busy,
                onTap: () => _run('promote'),
              ),
              _TriageButton(
                icon: PhosphorIcons.check,
                label: 'Keep',
                busy: _busy,
                onTap: () => _run('keep'),
              ),
              _TriageButton(
                icon: PhosphorIcons.trash,
                label: 'Drop',
                busy: _busy,
                onTap: () => _run('drop'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _TriageButton extends StatelessWidget {
  final PhosphorIconData icon;
  final String label;
  final bool busy;
  final VoidCallback onTap;

  const _TriageButton({required this.icon, required this.label, required this.busy, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return OutlinedButton(
      onPressed: busy ? null : onTap,
      style: OutlinedButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        textStyle: AeronautTheme.caption1,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          PhosphorIcon(icon, size: 14, color: AeronautColors.textSecondary),
          const SizedBox(width: 4),
          Text(label),
        ],
      ),
    );
  }
}
