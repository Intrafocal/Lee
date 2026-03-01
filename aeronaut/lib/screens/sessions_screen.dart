import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers/hester_provider.dart';
import '../providers/machines_provider.dart';
import '../services/hester_api.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';

/// Screen listing active Hester sessions.
///
/// Tap to load session history into the chat; swipe to delete.
class SessionsScreen extends ConsumerStatefulWidget {
  const SessionsScreen({super.key});

  @override
  ConsumerState<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends ConsumerState<SessionsScreen> {
  List<String> _sessions = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadSessions();
  }

  Future<void> _loadSessions() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    final machine = ref.read(machinesProvider).activeMachine;
    if (machine == null) {
      setState(() {
        _loading = false;
        _error = 'No active machine';
      });
      return;
    }

    final api = HesterApi(machine: machine);
    try {
      final sessions = await api.getSessions();
      setState(() {
        _sessions = sessions;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    } finally {
      api.dispose();
    }
  }

  Future<void> _deleteSession(String sessionId) async {
    final machine = ref.read(machinesProvider).activeMachine;
    if (machine == null) return;

    final api = HesterApi(machine: machine);
    try {
      final deleted = await api.deleteSession(sessionId);
      if (deleted) {
        setState(() {
          _sessions.remove(sessionId);
        });
      }
    } finally {
      api.dispose();
    }
  }

  void _loadSession(String sessionId) {
    ref.read(hesterChatProvider.notifier).loadSession(sessionId);
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Sessions'),
      ),
      body: RefreshIndicator(
        color: AeronautColors.accent,
        backgroundColor: AeronautColors.bgSurface,
        onRefresh: _loadSessions,
        child: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(
        child: CircularProgressIndicator(color: AeronautColors.accent),
      );
    }

    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, size: 48, color: AeronautColors.offline),
            const SizedBox(height: AeronautTheme.spacingMd),
            Text(_error!, style: AeronautTheme.caption),
            const SizedBox(height: AeronautTheme.spacingLg),
            ElevatedButton(
              onPressed: _loadSessions,
              child: const Text('Retry'),
            ),
          ],
        ),
      );
    }

    if (_sessions.isEmpty) {
      return ListView(
        children: [
          SizedBox(
            height: MediaQuery.of(context).size.height * 0.6,
            child: Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(
                    Icons.history,
                    size: 48,
                    color: AeronautColors.textTertiary,
                  ),
                  const SizedBox(height: AeronautTheme.spacingMd),
                  Text('No sessions', style: AeronautTheme.heading),
                  const SizedBox(height: AeronautTheme.spacingSm),
                  Text(
                    'Start a conversation to create a session',
                    style: AeronautTheme.caption,
                  ),
                ],
              ),
            ),
          ),
        ],
      );
    }

    return ListView.separated(
      itemCount: _sessions.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, index) {
        final sessionId = _sessions[index];
        return Dismissible(
          key: Key(sessionId),
          direction: DismissDirection.endToStart,
          background: Container(
            alignment: Alignment.centerRight,
            padding: const EdgeInsets.only(right: AeronautTheme.spacingLg),
            color: AeronautColors.offline,
            child: const Icon(Icons.delete, color: Colors.white),
          ),
          confirmDismiss: (_) async {
            return await showDialog<bool>(
              context: context,
              builder: (ctx) => AlertDialog(
                title: const Text('Delete session?'),
                content: Text('Session $sessionId will be permanently deleted.'),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.of(ctx).pop(false),
                    child: const Text('Cancel'),
                  ),
                  TextButton(
                    onPressed: () => Navigator.of(ctx).pop(true),
                    child: const Text('Delete'),
                  ),
                ],
              ),
            ) ?? false;
          },
          onDismissed: (_) => _deleteSession(sessionId),
          child: ListTile(
            leading: const Icon(
              Icons.chat_bubble_outline,
              color: AeronautColors.accent,
            ),
            title: Text(
              sessionId,
              style: AeronautTheme.mono.copyWith(fontSize: 12),
              overflow: TextOverflow.ellipsis,
            ),
            trailing: const Icon(
              Icons.chevron_right,
              color: AeronautColors.textTertiary,
            ),
            onTap: () => _loadSession(sessionId),
          ),
        );
      },
    );
  }
}
