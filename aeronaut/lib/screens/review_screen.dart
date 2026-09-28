import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/tether.dart';
import '../providers/machines_provider.dart';
import '../providers/tether_provider.dart';
import '../providers/windows_provider.dart';
import '../services/tether_api.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import '../theme/phosphor_tokens.dart';
import '../widgets/auth_banner.dart';
import '../widgets/machine_switcher.dart';
import '../widgets/phosphor_icon.dart';
import '../widgets/work_ui.dart';
import 'files_screen.dart';
import 'page_screen.dart';

/// Review's three views (docs/plans/2026-09-28-tether-review-voice.md §3.1).
enum ReviewSection { desk, drawer, files }

final reviewSectionProvider = StateProvider<ReviewSection>((ref) => ReviewSection.desk);

/// Review: read-only. **Desk** (Areas on the Desk → their Pages → a Page),
/// **Drawer** (Stashed Areas → their Pages, and Ideas; triage stays in Lee)
/// and **Files** (the Files browser, moved here from Machine). Devices read
/// the Desk; editing stays on the Mac.
class ReviewScreen extends ConsumerStatefulWidget {
  const ReviewScreen({super.key});

  @override
  ConsumerState<ReviewScreen> createState() => _ReviewScreenState();
}

class _ReviewScreenState extends ConsumerState<ReviewScreen> {
  @override
  void initState() {
    super.initState();
    // Work's Pick up opens its Page here, on Review's own stack.
    ref.listenManual<PageRequest?>(reviewPageRequestProvider, (_, request) {
      if (request == null) return;
      ref.read(reviewPageRequestProvider.notifier).state = null;
      Navigator.of(context).push(
        MaterialPageRoute<void>(builder: (_) => PageScreen(cardId: request.cardId, title: request.title)),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final section = ref.watch(reviewSectionProvider);
    final workspace = ref.watch(windowsProvider.select((s) => s.activeWindow?.workspace));
    return Scaffold(
      appBar: AppBar(
        title: const MachineSwitcher(),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(44),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(AeronautTheme.spacingMd, 0, AeronautTheme.spacingMd, AeronautTheme.spacingSm),
            child: SizedBox(
              width: double.infinity,
              // Segments are never phosphor (§0 rule 1).
              child: CupertinoSlidingSegmentedControl<ReviewSection>(
                key: const ValueKey('review-sections'),
                groupValue: section,
                backgroundColor: Phosphor.ground2,
                thumbColor: Phosphor.ground4,
                children: const {
                  ReviewSection.desk: Text('Desk', style: AeronautTheme.footnote),
                  ReviewSection.drawer: Text('Drawer', style: AeronautTheme.footnote),
                  ReviewSection.files: Text('Files', style: AeronautTheme.footnote),
                },
                onValueChanged: (v) {
                  if (v != null) ref.read(reviewSectionProvider.notifier).state = v;
                },
              ),
            ),
          ),
        ),
      ),
      body: Column(
        children: [
          const AuthBanner(),
          Expanded(
            child: switch (section) {
              ReviewSection.desk => DeskView(key: ValueKey('desk-$workspace'), workspace: workspace),
              ReviewSection.drawer => DrawerView(key: ValueKey('drawer-$workspace'), workspace: workspace),
              ReviewSection.files => const FilesBrowserBody(),
            },
          ),
        ],
      ),
    );
  }
}

/// "2h ago", "3d ago".
String ago(DateTime? at) {
  if (at == null) return '';
  final d = DateTime.now().toUtc().difference(at.toUtc());
  if (d.inMinutes < 1) return 'just now';
  if (d.inHours < 1) return '${d.inMinutes}m ago';
  if (d.inDays < 1) return '${d.inHours}h ago';
  return '${d.inDays}d ago';
}

/// Loads one `/tether/*` read and shows it, with pull to refresh and the
/// same plain words for "Hester is offline" everywhere.
class _Loader<T> extends ConsumerStatefulWidget {
  final Future<TetherRead<T>> Function(WidgetRef ref) load;
  final List<Widget> Function(BuildContext context, T value) build;

  const _Loader({required this.load, required this.build, super.key});

  @override
  ConsumerState<_Loader<T>> createState() => _LoaderState<T>();
}

class _LoaderState<T> extends ConsumerState<_Loader<T>> {
  TetherRead<T>? _read;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final read = await widget.load(ref);
    if (!mounted) return;
    setState(() {
      _read = read;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final read = _read;
    if (_loading && read == null) return const Center(child: CircularProgressIndicator.adaptive());
    final value = read?.value;
    return RefreshIndicator.adaptive(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.only(bottom: AeronautTheme.spacingXl),
        children: value != null
            ? widget.build(context, value)
            : [
                Padding(
                  padding: const EdgeInsets.all(AeronautTheme.spacingMd),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const SizedBox(height: AeronautTheme.spacingLg),
                      Text(read?.hesterOffline ?? false ? 'Hester is offline.' : 'This could not load.',
                          style: writingStyle(size: 20)),
                      const SizedBox(height: AeronautTheme.spacingSm),
                      QuietText(read?.hesterOffline ?? false
                          ? 'The Desk comes from Hester on the Mac. Pull to try again once Lee is running.'
                          : (read?.error ?? 'Pull to try again.')),
                    ],
                  ),
                ),
              ],
      ),
    );
  }
}

Future<TetherRead<T>> _withApi<T>(WidgetRef ref, Future<TetherRead<T>> Function(TetherApi api) call) async {
  final machine = ref.read(machinesProvider).activeMachine;
  if (machine == null) return const TetherRead.failed('No machine selected.');
  final api = ref.read(tetherApiFactoryProvider)(machine);
  try {
    return await call(api);
  } finally {
    api.dispose();
  }
}

void _openPage(BuildContext context, TetherCard card) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(builder: (_) => PageScreen(cardId: card.id, title: card.displayTitle)),
  );
}

void _openArea(BuildContext context, TetherArea area, {bool stashed = false}) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(builder: (_) => AreaScreen(area: area, stashed: stashed)),
  );
}

/// Review › Desk: the Goals card when there is one, then the Areas on the Desk.
class DeskView extends StatelessWidget {
  final String? workspace;

  const DeskView({required this.workspace, super.key});

  @override
  Widget build(BuildContext context) {
    return _Loader<TetherDesk>(
      load: (ref) => _withApi(ref, (api) => api.getDesk(workspace: workspace)),
      build: (context, desk) => [
        if (desk.goalsCard != null) ...[
          const Eyebrow('Goals'),
          _CardRow(card: desk.goalsCard!, last: desk.lastCardId == desk.goalsCard!.id),
        ],
        const Eyebrow('Areas'),
        if (desk.areas.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
            child: QuietText('No Areas on the Desk yet.'),
          ),
        for (final area in desk.areas)
          _AreaRow(
            key: ValueKey('area-${area.id}'),
            area: area,
            onTap: () => _openArea(context, area),
          ),
      ],
    );
  }
}

/// Review › Drawer: Stashed Areas, then Ideas (newest first, read-only).
class DrawerView extends StatelessWidget {
  final String? workspace;

  const DrawerView({required this.workspace, super.key});

  @override
  Widget build(BuildContext context) {
    return _Loader<TetherDrawer>(
      load: (ref) => _withApi(ref, (api) => api.getDrawer(workspace: workspace)),
      build: (context, drawer) => [
        const Eyebrow('Stashed'),
        if (drawer.stashed.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
            child: QuietText('Nothing stashed.'),
          ),
        for (final area in drawer.stashed)
          _AreaRow(
            key: ValueKey('stashed-${area.id}'),
            area: area,
            subtitle: area.stashedAt == null ? null : 'Stashed ${ago(area.stashedAt)}',
            onTap: () => _openArea(context, area, stashed: true),
          ),
        const Eyebrow('Ideas'),
        if (drawer.ideas.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
            child: QuietText('Nothing captured yet. Capture from Work, or with c on the T-Deck.'),
          ),
        for (final idea in drawer.ideas) _IdeaRow(key: ValueKey('idea-${idea.id}'), idea: idea),
        if (drawer.ideas.isNotEmpty)
          const Padding(
            padding: EdgeInsets.fromLTRB(AeronautTheme.spacingMd, AeronautTheme.spacingSm, AeronautTheme.spacingMd, 0),
            child: QuietText('Sort them into Pages at the Mac.'),
          ),
      ],
    );
  }
}

/// An Area's Pages, newest first.
class AreaScreen extends StatelessWidget {
  final TetherArea area;
  final bool stashed;

  const AreaScreen({required this.area, this.stashed = false, super.key});

  @override
  Widget build(BuildContext context) {
    final cards = [...area.cards]..sort((a, b) {
        final at = a.updatedAt, bt = b.updatedAt;
        if (at == null && bt == null) return 0;
        if (at == null) return 1;
        if (bt == null) return -1;
        return bt.compareTo(at);
      });
    return Scaffold(
      appBar: AppBar(title: Text(area.name.isEmpty ? 'Area' : area.name)),
      body: ListView(
        padding: const EdgeInsets.only(bottom: AeronautTheme.spacingXl),
        children: [
          if (stashed)
            const Padding(
              padding: EdgeInsets.fromLTRB(AeronautTheme.spacingMd, AeronautTheme.spacingMd, AeronautTheme.spacingMd, 0),
              child: QuietText('Stashed in the Drawer.'),
            ),
          const Eyebrow('Pages'),
          if (cards.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
              child: QuietText('No Pages in this Area.'),
            ),
          for (final c in cards) _CardRow(card: c),
        ],
      ),
    );
  }
}

class _AreaRow extends StatelessWidget {
  final TetherArea area;
  final String? subtitle;
  final VoidCallback onTap;

  const _AreaRow({required this.area, required this.onTap, this.subtitle, super.key});

  @override
  Widget build(BuildContext context) {
    final n = area.cards.length;
    final line = [n == 1 ? '1 Page' : '$n Pages', if (subtitle != null) subtitle!].join(' · ');
    return ListTile(
      onTap: onTap,
      contentPadding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
      leading: const PhosphorIcon(PhosphorIcons.area, size: 20, color: Phosphor.text2),
      title: Text(area.name.isEmpty ? 'Untitled Area' : area.name, style: AeronautTheme.subheadline),
      subtitle: Text(line, style: AeronautTheme.caption1.copyWith(color: Phosphor.text3)),
      trailing: const PhosphorIcon(PhosphorIcons.chevronRight, size: 16, color: Phosphor.text3),
    );
  }
}

class _CardRow extends StatelessWidget {
  final TetherCard card;

  /// Your last card: marked quietly, not lit.
  final bool last;

  const _CardRow({required this.card, this.last = false});

  @override
  Widget build(BuildContext context) {
    final bits = [
      if (last) 'Last card',
      if (card.updatedAt != null) ago(card.updatedAt),
      if (card.answers > 0) card.answers == 1 ? '1 answer' : '${card.answers} answers',
      if (card.openQuestions > 0) card.openQuestions == 1 ? '1 open question' : '${card.openQuestions} open questions',
    ];
    return ListTile(
      key: ValueKey('card-${card.id}'),
      onTap: () => _openPage(context, card),
      contentPadding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
      leading: const PhosphorIcon(PhosphorIcons.document, size: 20, color: Phosphor.text2),
      // A Page's title is your words.
      title: Text(card.displayTitle, style: writingStyle(size: 17)),
      subtitle: bits.isEmpty ? null : Text(bits.join(' · '), style: AeronautTheme.caption1.copyWith(color: Phosphor.text3)),
      trailing: const PhosphorIcon(PhosphorIcons.chevronRight, size: 16, color: Phosphor.text3),
    );
  }
}

String _surfaceLabel(String? surface) => switch (surface) {
      'lee' => 'Lee',
      'aeronaut' => 'Phone',
      'dirigible' => 'T-Deck',
      'cli' => 'CLI',
      'device' => 'Device',
      _ => '',
    };

class _IdeaRow extends StatefulWidget {
  final TetherIdea idea;

  const _IdeaRow({required this.idea, super.key});

  @override
  State<_IdeaRow> createState() => _IdeaRowState();
}

class _IdeaRowState extends State<_IdeaRow> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final idea = widget.idea;
    final meta = [_surfaceLabel(idea.surface), ago(idea.createdAt)].where((s) => s.isNotEmpty).join(' · ');
    return InkWell(
      onTap: () => setState(() => _expanded = !_expanded),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd, vertical: AeronautTheme.spacingSm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              idea.text,
              maxLines: _expanded ? null : 3,
              overflow: _expanded ? TextOverflow.visible : TextOverflow.ellipsis,
              // A thought captured away from the Mac is your words (§0 rule 3).
              style: idea.fromDevice ? writingStyle(size: 16) : AeronautTheme.footnote,
            ),
            if (meta.isNotEmpty) ...[
              const SizedBox(height: 2),
              Text(meta, style: AeronautTheme.caption2.copyWith(color: Phosphor.text3)),
            ],
          ],
        ),
      ),
    );
  }
}
