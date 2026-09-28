import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/tether.dart';
import '../providers/machines_provider.dart';
import '../providers/tether_provider.dart';
import '../providers/windows_provider.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import '../theme/phosphor_tokens.dart';
import '../widgets/phosphor_icon.dart';
import '../widgets/work_ui.dart';
import 'page_screen.dart';

/// Opens a Desk card in Review: a Board (`bd-…`) as its picture, anything
/// else as a Page.
void openDeskCard(BuildContext context, String cardId, String title) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => cardId.startsWith('bd-') ? BoardScreen(cardId: cardId, title: title) : PageScreen(cardId: cardId, title: title),
    ),
  );
}

/// A Board in Review, read-only (docs/plans/2026-09-28-boards.md §5b B5):
/// its picture (pinch to zoom), then its notes in the writing font (they're
/// your words), its links (a tap opens that card), and its asks and
/// hand-offs folded, as on a Page. The picture is the one Lee last drew;
/// the phone never draws a Board.
class BoardScreen extends ConsumerStatefulWidget {
  final String cardId;

  /// Shown while the Board loads.
  final String title;

  const BoardScreen({required this.cardId, this.title = '', super.key});

  @override
  ConsumerState<BoardScreen> createState() => _BoardScreenState();
}

class _BoardScreenState extends ConsumerState<BoardScreen> {
  TetherRead<TetherBoard>? _read;
  Uint8List? _picture;
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
    final workspace = ref.read(windowsProvider).activeWindow?.workspace;
    final api = ref.read(tetherApiFactoryProvider)(machine);
    try {
      final read = await api.getBoard(widget.cardId, workspace: workspace);
      final picture = read.value?.hasPreview ?? false
          ? await api.fetchAsset(api.boardPreviewUri(widget.cardId, workspace: workspace))
          : null;
      if (!mounted) return;
      setState(() {
        _read = read;
        _picture = picture;
        _loading = false;
      });
    } finally {
      api.dispose();
    }
  }

  @override
  Widget build(BuildContext context) {
    final board = _read?.value;
    final title = board?.card.displayTitle ?? (widget.title.isEmpty ? 'Board' : widget.title);
    return Scaffold(
      appBar: AppBar(title: Text(title, overflow: TextOverflow.ellipsis)),
      body: _loading && board == null
          ? const Center(child: CircularProgressIndicator.adaptive())
          : RefreshIndicator.adaptive(
              onRefresh: _load,
              child: board == null
                  ? ListView(
                      padding: const EdgeInsets.all(AeronautTheme.spacingMd),
                      children: [
                        const SizedBox(height: AeronautTheme.spacingXl),
                        Text(
                          _read?.hesterOffline ?? false ? 'Hester is offline.' : 'This Board could not load.',
                          style: writingStyle(size: 20),
                        ),
                        const SizedBox(height: AeronautTheme.spacingSm),
                        QuietText(_read?.hesterOffline ?? false
                            ? 'Boards come from Hester on the Mac. Pull to try again once Lee is running.'
                            : (_read?.error ?? 'Pull to try again.')),
                      ],
                    )
                  : _BoardBody(board: board, picture: _picture),
            ),
    );
  }
}

class _BoardBody extends StatelessWidget {
  final TetherBoard board;
  final Uint8List? picture;

  const _BoardBody({required this.board, required this.picture});

  @override
  Widget build(BuildContext context) {
    final card = board.card;
    final where = [
      if (card.areaName != null) card.areaName!,
      if (card.stashed) 'Stashed',
    ].join(' · ');
    return ListView(
      padding: const EdgeInsets.fromLTRB(AeronautTheme.spacingMd, AeronautTheme.spacingMd, AeronautTheme.spacingMd, AeronautTheme.spacingXl),
      children: [
        if (where.isNotEmpty) ...[QuietText(where), const SizedBox(height: AeronautTheme.spacingSm)],
        _BoardPicture(bytes: picture, title: card.displayTitle),
        if (board.notes.isNotEmpty) ...[
          const SizedBox(height: AeronautTheme.spacingMd),
          for (final note in board.notes)
            Padding(
              padding: const EdgeInsets.only(bottom: AeronautTheme.spacingSm),
              child: SelectableText(note, style: writingStyle(size: 17)),
            ),
        ] else ...[
          const SizedBox(height: AeronautTheme.spacingSm),
          const QuietText('No notes on this Board yet.'),
        ],
        if (board.links.isNotEmpty) ...[
          const SizedBox(height: AeronautTheme.spacingSm),
          for (final link in board.links)
            ListTile(
              key: ValueKey('board-link-${link.cardId}'),
              onTap: () => openDeskCard(context, link.cardId, link.displayTitle),
              contentPadding: EdgeInsets.zero,
              dense: true,
              leading: PhosphorIcon(link.isBoard ? PhosphorIcons.image : PhosphorIcons.document, size: 18, color: Phosphor.text2),
              title: Text(link.displayTitle, style: writingStyle(size: 16)),
              trailing: const PhosphorIcon(PhosphorIcons.chevronRight, size: 16, color: Phosphor.text3),
            ),
        ],
        if (board.asks.isNotEmpty)
          ReviewFold(
            key: const ValueKey('board-asks'),
            label: 'Asks',
            count: board.asks.length,
            children: [
              for (final a in board.asks)
                ReviewEntry(
                  head: a.question,
                  headIsYours: true,
                  body: a.answer ?? (a.status.isEmpty ? 'No answer yet.' : a.status),
                ),
            ],
          ),
        if (board.handoffs.isNotEmpty)
          ReviewFold(
            key: const ValueKey('board-handoffs'),
            label: 'Hand-offs',
            count: board.handoffs.length,
            children: [
              for (final h in board.handoffs)
                ReviewEntry(
                  head: [h.kind, h.status].where((s) => s.isNotEmpty).join(' · '),
                  body: h.result ?? 'No result yet.',
                ),
            ],
          ),
      ],
    );
  }
}

/// The Board as Lee last drew it, pinch to zoom; a quiet placeholder when
/// Lee hasn't drawn one (or it couldn't load).
class _BoardPicture extends StatelessWidget {
  final Uint8List? bytes;
  final String title;

  const _BoardPicture({required this.bytes, required this.title});

  @override
  Widget build(BuildContext context) {
    if (bytes == null) {
      return Container(
        key: const ValueKey('board-no-picture'),
        height: 120,
        width: double.infinity,
        padding: const EdgeInsets.all(AeronautTheme.spacingMd),
        decoration: BoxDecoration(
          color: Phosphor.ground2,
          borderRadius: BorderRadius.circular(Phosphor.radiusCard),
          border: Border.all(color: Phosphor.ground4),
        ),
        alignment: Alignment.center,
        child: const QuietText('No picture of this Board yet. Open it in Lee to draw one.'),
      );
    }
    return ClipRRect(
      key: const ValueKey('board-picture'),
      borderRadius: BorderRadius.circular(Phosphor.radiusCard),
      child: Container(
        color: Phosphor.ground2,
        child: InteractiveViewer(
          minScale: 1,
          maxScale: 6,
          child: Image.memory(bytes!, fit: BoxFit.contain, semanticLabel: title),
        ),
      ),
    );
  }
}
