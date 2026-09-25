import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/machine.dart';
import '../providers/machines_provider.dart';
import '../services/api_auth.dart';
import '../services/hester_api.dart';
import '../services/lee_api.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import '../widgets/auth_banner.dart';
import '../widgets/phosphor_icon.dart';

/// Health and connection detail for one machine.
///
/// Shows Lee's `GET /health` (unauthenticated) plus an authenticated probe so
/// a rejected token is distinguishable from an unreachable host, and Hester's
/// `GET /health` — including `auth` and the `workspace` the daemon is
/// currently pointed at, which is the project Hester answers questions about.
class MachineDetailScreen extends ConsumerStatefulWidget {
  final Machine machine;

  const MachineDetailScreen({required this.machine, super.key});

  @override
  ConsumerState<MachineDetailScreen> createState() =>
      _MachineDetailScreenState();
}

class _MachineDetailScreenState extends ConsumerState<MachineDetailScreen> {
  Map<String, dynamic>? _leeHealth;
  Map<String, dynamic>? _hesterHealth;
  ApiStatus _leeAuth = ApiStatus.unreachable;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _loading = true);
    final leeApi = LeeApi(machine: widget.machine);
    final hesterApi = HesterApi(machine: widget.machine);
    try {
      final results = await Future.wait([
        leeApi.getHealth(),
        leeApi.probe(),
        hesterApi.getHealth(),
      ]);
      if (!mounted) return;
      setState(() {
        _leeHealth = results[0] as Map<String, dynamic>?;
        _leeAuth = results[1] as ApiStatus;
        _hesterHealth = results[2] as Map<String, dynamic>?;
        _loading = false;
      });
    } finally {
      leeApi.dispose();
      hesterApi.dispose();
    }
  }

  @override
  Widget build(BuildContext context) {
    final machine = widget.machine;
    final health = ref.watch(machinesProvider).healthOf(machine.id);

    final agent = _hesterHealth?['components'] is Map<String, dynamic>
        ? (_hesterHealth!['components']
            as Map<String, dynamic>)['agent'] as Map<String, dynamic>?
        : null;

    return Scaffold(
      appBar: AppBar(
        title: Text(machine.name),
        actions: [
          IconButton(
            icon: const PhosphorIcon(PhosphorIcons.refresh),
            tooltip: 'Refresh',
            onPressed: _loading ? null : _refresh,
          ),
        ],
      ),
      body: Column(
        children: [
          const AuthBanner(),
          if (_loading) const LinearProgressIndicator(minHeight: 2),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.all(AeronautTheme.spacingMd),
              children: [
                _Section(
                  title: 'Connection',
                  rows: [
                    _Row('Host', '${machine.host}:${machine.hostPort}'),
                    _Row(
                      'Hester port',
                      machine.hesterPort?.toString() ?? 'not configured',
                    ),
                    _Row('Token', machine.token.isEmpty ? 'none' : 'saved'),
                    _Row('Status', _healthLabel(health)),
                  ],
                ),
                _Section(
                  title: 'Lee  ·  :${machine.hostPort}',
                  rows: [
                    _Row(
                      'Reachable',
                      _leeHealth == null ? 'no' : 'yes',
                    ),
                    _Row('Status', _leeHealth?['status']?.toString() ?? '—'),
                    _Row('Version', _leeHealth?['version']?.toString() ?? '—'),
                    _Row(
                      'Platform',
                      _leeHealth?['platform']?.toString() ?? '—',
                    ),
                    _Row('Authenticated routes', _authLabel(_leeAuth)),
                  ],
                ),
                _Section(
                  title: machine.hesterPort == null
                      ? 'Hester'
                      : 'Hester  ·  :${machine.hesterPort}',
                  rows: [
                    _Row(
                      'Reachable',
                      _hesterHealth == null ? 'no' : 'yes',
                    ),
                    _Row(
                      'Status',
                      _hesterHealth?['status']?.toString() ?? '—',
                    ),
                    // D6: the two fields that tell you whether the daemon is
                    // locked down and which project it is answering about.
                    _Row('Auth', _hesterHealth?['auth']?.toString() ?? '—'),
                    _Row(
                      'Workspace',
                      _hesterHealth?['workspace']?.toString() ?? '—',
                      mono: true,
                    ),
                    _Row(
                      'Sessions',
                      _hesterHealth?['session_backend']?.toString() ?? '—',
                    ),
                    _Row('Model', agent?['model']?.toString() ?? '—'),
                    _Row(
                      'Tools',
                      agent?['tools_registered']?.toString() ?? '—',
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  String _healthLabel(MachineHealth health) {
    switch (health) {
      case MachineHealth.online:
        return 'online';
      case MachineHealth.offline:
        return 'offline';
      case MachineHealth.unauthorized:
        return AuthFailure.message;
      case MachineHealth.unknown:
        return 'unknown';
    }
  }

  String _authLabel(ApiStatus status) {
    switch (status) {
      case ApiStatus.ok:
        return 'token accepted';
      case ApiStatus.unauthorized:
        return AuthFailure.message;
      case ApiStatus.unreachable:
        return 'unreachable';
    }
  }
}

class _Row {
  final String label;
  final String value;
  final bool mono;

  const _Row(this.label, this.value, {this.mono = false});
}

class _Section extends StatelessWidget {
  final String title;
  final List<_Row> rows;

  const _Section({required this.title, required this.rows});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AeronautTheme.spacingLg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title.toUpperCase(),
            style: AeronautTheme.caption2.copyWith(
              letterSpacing: 0.6,
              fontWeight: FontWeight.w600,
              color: AeronautColors.textSecondary,
            ),
          ),
          const SizedBox(height: AeronautTheme.spacingSm),
          Container(
            decoration: BoxDecoration(
              color: AeronautColors.bgSurface,
              borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
              border: Border.all(color: AeronautColors.border),
            ),
            child: Column(
              children: [
                for (var i = 0; i < rows.length; i++) ...[
                  if (i > 0) const Divider(height: 1),
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AeronautTheme.spacingMd,
                      vertical: AeronautTheme.spacingSm,
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SizedBox(
                          width: 110,
                          child: Text(
                            rows[i].label,
                            style: AeronautTheme.caption1,
                          ),
                        ),
                        Expanded(
                          child: SelectableText(
                            rows[i].value,
                            style: rows[i].mono
                                ? AeronautTheme.mono
                                : AeronautTheme.footnote.copyWith(color: AeronautColors.textPrimary),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
