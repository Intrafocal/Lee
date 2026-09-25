import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/fs_entry.dart';
import '../models/machine.dart';
import '../providers/context_provider.dart';
import '../providers/machines_provider.dart';
import '../services/fs_api.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import '../widgets/phosphor_icon.dart';
import 'file_viewer_screen.dart';

/// Files browser body for the active machine's current workspace, driven by
/// `GET /fs/list`. Used two ways: embedded directly for a `files` tab
/// (no extra chrome — the tab bar above it is enough), and wrapped in
/// [FilesScreen] when pushed from the home screen's app bar so it's
/// reachable even when no `files` tab is open in Lee.
///
/// Directories lazily expand in place (`_DirNode` fetches and caches its
/// own children on first expansion); tapping a file pushes
/// [FileViewerScreen].
class FilesBrowserBody extends ConsumerWidget {
  const FilesBrowserBody({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final machine = ref.watch(machinesProvider).activeMachine;
    final workspace = ref.watch(workspaceRootProvider);

    if (machine == null) {
      return const Center(child: Text('No machine selected'));
    }
    if (workspace == null || workspace.isEmpty) {
      return const Center(
        child: Text(
          'No workspace open on this window',
          style: AeronautTheme.caption1,
        ),
      );
    }
    return _DirBody(machine: machine, path: workspace, isRoot: true);
  }
}

/// Full-screen route for Files, pushed from the home screen's app bar.
class FilesScreen extends StatelessWidget {
  const FilesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Files')),
      body: const FilesBrowserBody(),
    );
  }
}

/// Provider for the workspace of the currently active window — the root the
/// Files browser opens against.
final workspaceRootProvider = Provider.autoDispose<String?>((ref) {
  final ctx = ref.watch(leeContextProvider).valueOrNull;
  return ctx?.workspace;
});

class _DirBody extends ConsumerStatefulWidget {
  final Machine machine;
  final String path;
  final bool isRoot;

  const _DirBody({required this.machine, required this.path, this.isRoot = false});

  @override
  ConsumerState<_DirBody> createState() => _DirBodyState();
}

class _DirBodyState extends ConsumerState<_DirBody> {
  FsListResult? _result;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final api = FsApi(machine: widget.machine);
    try {
      final result = await api.listDir(widget.path);
      if (!mounted) return;
      setState(() {
        _result = result;
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
    if (_loading && _result == null) {
      return const Center(
        child: CircularProgressIndicator.adaptive(
          strokeWidth: 2,
        ),
      );
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(AeronautTheme.spacingLg),
          child: Text(
            _error!,
            textAlign: TextAlign.center,
            style: AeronautTheme.caption1,
          ),
        ),
      );
    }
    final entries = _result?.entries ?? const <FsEntryInfo>[];
    if (entries.isEmpty) {
      return const Center(
        child: Text('Empty directory', style: AeronautTheme.caption1),
      );
    }

    final content = ListView.builder(
      padding: EdgeInsets.zero,
      shrinkWrap: !widget.isRoot,
      physics: widget.isRoot ? null : const NeverScrollableScrollPhysics(),
      itemCount: entries.length,
      itemBuilder: (context, index) {
        final entry = entries[index];
        final fullPath = '${widget.path}/${entry.name}';
        if (entry.isDir) {
          return _DirNode(machine: widget.machine, name: entry.name, path: fullPath);
        }
        return _FileTile(machine: widget.machine, name: entry.name, path: fullPath, entry: entry);
      },
    );

    if (widget.isRoot) {
      return RefreshIndicator.adaptive(
        color: AeronautColors.accent,
        onRefresh: _load,
        child: content,
      );
    }
    return content;
  }
}

/// A lazily-expanding directory node. Fetches its children the first time
/// it's expanded and keeps them cached for the life of the widget.
class _DirNode extends StatefulWidget {
  final Machine machine;
  final String name;
  final String path;

  const _DirNode({required this.machine, required this.name, required this.path});

  @override
  State<_DirNode> createState() => _DirNodeState();
}

class _DirNodeState extends State<_DirNode> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        key: PageStorageKey(widget.path),
        leading: const PhosphorIcon(PhosphorIcons.folder, color: AeronautColors.accent, size: 20),
        title: Text(
          widget.name,
          style: AeronautTheme.subheadline,
        ),
        tilePadding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
        childrenPadding: const EdgeInsets.only(left: AeronautTheme.spacingMd),
        onExpansionChanged: (expanded) => setState(() => _expanded = expanded),
        children: _expanded
            ? [_DirBody(machine: widget.machine, path: widget.path)]
            : const [],
      ),
    );
  }
}

class _FileTile extends StatelessWidget {
  final Machine machine;
  final String name;
  final String path;
  final FsEntryInfo entry;

  const _FileTile({
    required this.machine,
    required this.name,
    required this.path,
    required this.entry,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      dense: true,
      leading: PhosphorIcon(
        entry.isSymlink ? PhosphorIcons.link : _iconFor(name),
        size: 18,
        color: AeronautColors.textSecondary,
      ),
      title: Text(name, style: AeronautTheme.subheadline),
      subtitle: Text(_formatSize(entry.size), style: AeronautTheme.caption2),
      onTap: () {
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => Scaffold(
              appBar: AppBar(title: Text(name)),
              body: FileViewerScreen(filePath: path),
            ),
          ),
        );
      },
    );
  }

  PhosphorIconData _iconFor(String name) {
    switch (classifyFile(name)) {
      case FileViewKind.markdown:
        return PhosphorIcons.book;
      case FileViewKind.code:
        return PhosphorIcons.fileCode;
      case FileViewKind.image:
        return PhosphorIcons.image;
      case FileViewKind.pdf:
        // No PDF icon in the Phosphor set; generic file is the closest fit.
        return PhosphorIcons.fileCode;
      case FileViewKind.binary:
      case FileViewKind.text:
        return PhosphorIcons.fileCode;
    }
  }

  String _formatSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(2)} MB';
  }
}
