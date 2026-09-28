import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/tether.dart';
import '../providers/machines_provider.dart';
import '../providers/tether_provider.dart';
import '../providers/windows_provider.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_tokens.dart';
import '../widgets/work_ui.dart';

/// A Page in Review, read-only (docs/plans/2026-09-28-tether-review-voice.md
/// §3.1): its markdown in the writing font (it's your words), images
/// fetched from Lee with auth, then its answers, hand-off results, open
/// questions and references, each collapsed.
class PageScreen extends ConsumerStatefulWidget {
  final String cardId;

  /// Shown while the Page loads.
  final String title;

  const PageScreen({required this.cardId, this.title = '', super.key});

  @override
  ConsumerState<PageScreen> createState() => _PageScreenState();
}

class _PageScreenState extends ConsumerState<PageScreen> {
  TetherRead<TetherPage>? _read;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final machine = ref.read(machinesProvider).activeMachine;
    if (machine == null) return;
    setState(() => _loading = true);
    final api = ref.read(tetherApiFactoryProvider)(machine);
    try {
      final read = await api.getPage(widget.cardId, workspace: ref.read(windowsProvider).activeWindow?.workspace);
      if (!mounted) return;
      setState(() {
        _read = read;
        _loading = false;
      });
    } finally {
      api.dispose();
    }
  }

  @override
  Widget build(BuildContext context) {
    final page = _read?.value;
    final title = page?.card.displayTitle ?? (widget.title.isEmpty ? 'Page' : widget.title);
    return Scaffold(
      appBar: AppBar(title: Text(title, overflow: TextOverflow.ellipsis)),
      body: _loading && page == null
          ? const Center(child: CircularProgressIndicator.adaptive())
          : RefreshIndicator.adaptive(
              onRefresh: _load,
              child: page == null
                  ? ListView(
                      padding: const EdgeInsets.all(AeronautTheme.spacingMd),
                      children: [
                        const SizedBox(height: AeronautTheme.spacingXl),
                        Text(
                          _read?.hesterOffline ?? false ? 'Hester is offline.' : 'This Page could not load.',
                          style: writingStyle(size: 20),
                        ),
                        const SizedBox(height: AeronautTheme.spacingSm),
                        QuietText(_read?.hesterOffline ?? false
                            ? 'Pages come from Hester on the Mac. Pull to try again once Lee is running.'
                            : (_read?.error ?? 'Pull to try again.')),
                      ],
                    )
                  : _PageBody(page: page),
            ),
    );
  }
}

class _PageBody extends ConsumerWidget {
  final TetherPage page;

  const _PageBody({required this.page});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final card = page.card;
    final where = [
      if (card.areaName != null) card.areaName!,
      if (card.stashed) 'Stashed',
    ].join(' · ');
    final base = AeronautTheme.markdown(context);
    final sheet = base.copyWith(
      p: writingStyle(size: 17),
      listBullet: writingStyle(size: 17),
      blockquote: writingStyle(size: 17, italic: true, color: Phosphor.text2),
      h1: writingStyle(size: 26),
      h2: writingStyle(size: 22),
      h3: writingStyle(size: 19),
      em: writingStyle(size: 17, italic: true),
      strong: writingStyle(size: 17).copyWith(fontWeight: FontWeight.w600),
    );
    return ListView(
      padding: const EdgeInsets.fromLTRB(AeronautTheme.spacingMd, AeronautTheme.spacingMd, AeronautTheme.spacingMd, AeronautTheme.spacingXl),
      children: [
        if (where.isNotEmpty) ...[QuietText(where), const SizedBox(height: AeronautTheme.spacingSm)],
        if (page.text.trim().isEmpty)
          const QuietText('Nothing written yet.')
        else
          MarkdownBody(
            key: const ValueKey('page-text'),
            data: page.text,
            selectable: true,
            styleSheet: sheet,
            onTapLink: (_, href, _) {
              if (href != null && (href.startsWith('http://') || href.startsWith('https://'))) {
                launchUrl(Uri.parse(href));
              }
            },
            imageBuilder: (uri, title, alt) => _PageImage(cardId: card.id, src: uri.toString(), alt: alt),
          ),
        if (page.answers.isNotEmpty)
          _Fold(
            key: const ValueKey('page-answers'),
            label: 'Answers',
            count: page.answers.length,
            children: [
              for (final a in page.answers)
                _Entry(
                  head: a.question,
                  headIsYours: true,
                  body: a.answer ?? (a.status.isEmpty ? 'No answer yet.' : a.status),
                ),
            ],
          ),
        if (page.handoffs.isNotEmpty)
          _Fold(
            key: const ValueKey('page-handoffs'),
            label: 'Hand-offs',
            count: page.handoffs.length,
            children: [
              for (final h in page.handoffs)
                _Entry(
                  head: [h.kind, if (h.provider != null) h.provider!, h.status].where((s) => s.isNotEmpty).join(' · '),
                  body: h.result ?? 'No result yet.',
                ),
            ],
          ),
        if (page.openQuestions.isNotEmpty)
          _Fold(
            key: const ValueKey('page-questions'),
            label: 'Open questions',
            count: page.openQuestions.length,
            children: [
              for (final q in page.openQuestions)
                Padding(
                  padding: const EdgeInsets.only(bottom: AeronautTheme.spacingSm),
                  child: Text(q.text, style: writingStyle(size: 17)),
                ),
            ],
          ),
        if (page.references.isNotEmpty)
          _Fold(
            key: const ValueKey('page-references'),
            label: 'References',
            count: page.references.length,
            children: [
              for (final r in page.references)
                _Entry(
                  head: r.title.isEmpty ? (r.where ?? 'Reference') : r.title,
                  body: [if (r.where != null && r.title.isNotEmpty) r.where!, if (r.quote != null) '“${r.quote!}”'].join('\n'),
                ),
            ],
          ),
      ],
    );
  }
}

/// A Page's image: `assets/<name>` fetched through Lee with the bearer
/// token; anything else shows its alt text.
class _PageImage extends ConsumerStatefulWidget {
  final String cardId;
  final String src;
  final String? alt;

  const _PageImage({required this.cardId, required this.src, this.alt});

  @override
  ConsumerState<_PageImage> createState() => _PageImageState();
}

class _PageImageState extends ConsumerState<_PageImage> {
  Uint8List? _bytes;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  Future<void> _fetch() async {
    final machine = ref.read(machinesProvider).activeMachine;
    if (machine == null) return;
    final api = ref.read(tetherApiFactoryProvider)(machine);
    try {
      final uri = api.assetUri(widget.cardId, widget.src, workspace: ref.read(windowsProvider).activeWindow?.workspace);
      final bytes = uri == null ? null : await api.fetchAsset(uri);
      if (!mounted) return;
      setState(() {
        _bytes = bytes;
        _failed = bytes == null;
      });
    } finally {
      api.dispose();
    }
  }

  @override
  Widget build(BuildContext context) {
    final alt = (widget.alt ?? '').trim();
    if (_bytes != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: AeronautTheme.spacingSm),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(Phosphor.radiusCard),
          child: Image.memory(_bytes!, fit: BoxFit.contain, semanticLabel: alt.isEmpty ? null : alt),
        ),
      );
    }
    return Container(
      height: _failed ? null : 120,
      width: double.infinity,
      padding: const EdgeInsets.all(AeronautTheme.spacingSm),
      decoration: BoxDecoration(
        color: Phosphor.ground2,
        borderRadius: BorderRadius.circular(Phosphor.radiusCard),
        border: Border.all(color: Phosphor.ground4),
      ),
      alignment: Alignment.center,
      child: _failed
          ? QuietText(alt.isEmpty ? 'An image (could not load)' : 'An image: $alt (could not load)')
          : const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Phosphor.text3)),
    );
  }
}

/// A collapsed group under the Page: "ANSWERS · 3".
class _Fold extends StatelessWidget {
  final String label;
  final int count;
  final List<Widget> children;

  const _Fold({required this.label, required this.count, required this.children, super.key});

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        tilePadding: EdgeInsets.zero,
        childrenPadding: const EdgeInsets.only(bottom: AeronautTheme.spacingSm),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        iconColor: Phosphor.text3,
        collapsedIconColor: Phosphor.text3,
        title: Text(
          '${label.toUpperCase()} · $count',
          style: const TextStyle(fontSize: 12, letterSpacing: 0.72, fontWeight: FontWeight.w500, color: Phosphor.text3),
        ),
        children: children,
      ),
    );
  }
}

class _Entry extends StatelessWidget {
  final String head;
  final String body;

  /// The head is your words (a question you asked).
  final bool headIsYours;

  const _Entry({required this.head, required this.body, this.headIsYours = false});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AeronautTheme.spacingMd),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (head.isNotEmpty)
            Text(head, style: headIsYours ? writingStyle(size: 17) : AeronautTheme.footnote.copyWith(color: Phosphor.text2)),
          if (body.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(body, style: AeronautTheme.subheadline.copyWith(color: Phosphor.text1)),
          ],
        ],
      ),
    );
  }
}
