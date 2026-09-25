import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/hester_models.dart';
import '../providers/machines_provider.dart';
import '../services/hester_api.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import '../widgets/phosphor_icon.dart';

/// Screen listing context bundles from Hester.
///
/// Shows id, title, tags, stale indicator. Tap to view full content.
class BundlesScreen extends ConsumerStatefulWidget {
  const BundlesScreen({super.key});

  @override
  ConsumerState<BundlesScreen> createState() => _BundlesScreenState();
}

class _BundlesScreenState extends ConsumerState<BundlesScreen> {
  List<BundleSummary> _bundles = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadBundles();
  }

  Future<void> _loadBundles() async {
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
      final bundles = await api.getBundles();
      setState(() {
        _bundles = bundles;
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

  void _viewBundle(BundleSummary bundle) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _BundleDetailScreen(bundleId: bundle.id, title: bundle.title),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Context Bundles'),
      ),
      body: RefreshIndicator.adaptive(
        color: AeronautColors.accent,
        backgroundColor: AeronautColors.bgSurface,
        onRefresh: _loadBundles,
        child: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(
        child: CircularProgressIndicator.adaptive(),
      );
    }

    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const PhosphorIcon(PhosphorIcons.warning, size: 48, color: AeronautColors.offline),
            const SizedBox(height: AeronautTheme.spacingMd),
            Text(_error!, style: AeronautTheme.caption1),
            const SizedBox(height: AeronautTheme.spacingLg),
            ElevatedButton(
              onPressed: _loadBundles,
              child: const Text('Retry'),
            ),
          ],
        ),
      );
    }

    if (_bundles.isEmpty) {
      return ListView(
        children: [
          SizedBox(
            height: MediaQuery.of(context).size.height * 0.6,
            child: const Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  PhosphorIcon(
                    PhosphorIcons.package,
                    size: 48,
                    color: AeronautColors.textTertiary,
                  ),
                  SizedBox(height: AeronautTheme.spacingMd),
                  Text('No bundles', style: AeronautTheme.headline),
                  SizedBox(height: AeronautTheme.spacingSm),
                  Text(
                    'Create bundles with: hester context create',
                    style: AeronautTheme.caption1,
                  ),
                ],
              ),
            ),
          ),
        ],
      );
    }

    return ListView.separated(
      itemCount: _bundles.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, index) {
        final bundle = _bundles[index];
        return _BundleTile(
          bundle: bundle,
          onTap: () => _viewBundle(bundle),
        );
      },
    );
  }
}

/// List tile for a single bundle.
class _BundleTile extends StatelessWidget {
  final BundleSummary bundle;
  final VoidCallback onTap;

  const _BundleTile({required this.bundle, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: PhosphorIcon(
        PhosphorIcons.package,
        color: bundle.stale ? AeronautColors.warning : AeronautColors.accent,
      ),
      title: Text(
        bundle.title.isNotEmpty ? bundle.title : bundle.id,
        style: AeronautTheme.subheadline,
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            bundle.id,
            style: AeronautTheme.mono.copyWith(
              fontSize: AeronautTheme.caption2.fontSize,
              color: AeronautColors.textTertiary,
            ),
          ),
          if (bundle.tags.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: AeronautTheme.spacingXs),
              child: Wrap(
                spacing: 4,
                children: bundle.tags.map((tag) => _Tag(label: tag)).toList(),
              ),
            ),
        ],
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (bundle.stale)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: AeronautColors.warning.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(AeronautTheme.radiusSm),
              ),
              child: Text(
                'STALE',
                style: AeronautTheme.caption2.copyWith(
                  color: AeronautColors.warning,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          const SizedBox(width: 4),
          Text(
            '${bundle.sourceCount} src',
            style: AeronautTheme.caption2,
          ),
          const PhosphorIcon(PhosphorIcons.chevronRight, color: AeronautColors.textTertiary),
        ],
      ),
      onTap: onTap,
    );
  }
}

/// Small tag chip.
class _Tag extends StatelessWidget {
  final String label;

  const _Tag({required this.label});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: AeronautColors.bgElevated,
        borderRadius: BorderRadius.circular(AeronautTheme.radiusSm),
      ),
      child: Text(
        label,
        style: AeronautTheme.caption2,
      ),
    );
  }
}

/// Detail screen showing full bundle content.
class _BundleDetailScreen extends ConsumerStatefulWidget {
  final String bundleId;
  final String title;

  const _BundleDetailScreen({required this.bundleId, required this.title});

  @override
  ConsumerState<_BundleDetailScreen> createState() =>
      _BundleDetailScreenState();
}

class _BundleDetailScreenState extends ConsumerState<_BundleDetailScreen> {
  String? _content;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadContent();
  }

  Future<void> _loadContent() async {
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
      final content = await api.getBundleContent(widget.bundleId);
      setState(() {
        _content = content;
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title.isNotEmpty ? widget.title : widget.bundleId),
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(
        child: CircularProgressIndicator.adaptive(),
      );
    }

    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const PhosphorIcon(PhosphorIcons.warning, size: 48, color: AeronautColors.offline),
            const SizedBox(height: AeronautTheme.spacingMd),
            Text(_error!, style: AeronautTheme.caption1),
          ],
        ),
      );
    }

    if (_content == null) {
      return const Center(
        child: Text('Bundle not found', style: AeronautTheme.caption1),
      );
    }

    return Markdown(
      data: _content!,
      selectable: true,
      padding: const EdgeInsets.all(AeronautTheme.spacingMd),
      onTapLink: (_, href, _) {
        if (href != null) launchUrl(Uri.parse(href));
      },
      styleSheet: AeronautTheme.markdown(context, compact: true),
    );
  }
}
