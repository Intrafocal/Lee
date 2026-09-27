import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/attention.dart';
import '../providers/attention_provider.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import 'phosphor_icon.dart';
import 'work_ui.dart';

/// The quick replies (cockpit design §4.4): Work's waiting cards show the
/// first three, the one-agent screen all four. Same list as
/// `QUICK_REPLIES` in `electron/src/shared/cockpit.ts`; change both
/// together. Each is sent exactly as shown, through the item's Reply.
const List<String> quickReplyChips = [
  'Yes, go ahead',
  'Stop and wait for me',
  'Explain first',
  'Show me the diff',
];

/// Item kinds that take a free-text reply and so get [quickReplyChips]
/// (contracts §5.2: "waiting/question, blocker, decision, review" — not
/// approval, which uses Allow/Deny, and not failure/summary, which don't
/// take a reply in practice).
const Set<AttentionKind> _chipKinds = {
  AttentionKind.waiting,
  AttentionKind.blocker,
  AttentionKind.decision,
  AttentionKind.review,
};

/// Whether [item] takes the quick replies.
bool takesQuickReplies(AttentionItem item) =>
    item.canReply && _chipKinds.contains(item.kind) && item.kind != AttentionKind.question;

/// One waiting card in Work (cockpit design §4.1, §8.1): the needs-you dot,
/// the title and age, the agent's words, and by kind: 44px Allow/Deny for
/// approvals, the quick-reply chips in a sideways scroll for text items, the
/// options for a question. Snooze, dismiss and wake sit in the `⋯` menu.
///
/// Swipe right snoozes and swipe left dismisses (contracts §5.2). Allow and
/// Deny are never bound to a swipe — they stay explicit taps only (C3: a
/// stray gesture must never approve something).
class AttentionTile extends ConsumerStatefulWidget {
  final AttentionItem item;
  final bool awayActive;

  /// The first card in Work: its Allow is the view's one phosphor control.
  final bool raised;

  /// Opens the one-agent screen (a tap on the card outside its controls).
  final VoidCallback? onOpen;

  /// "Write a reply…": opens the one-agent screen with its reply bar; when
  /// null the card opens an inline field instead.
  final VoidCallback? onWriteReply;

  /// A quiet usage label for the agent behind the item ("412k tok").
  final String? tokenLabel;

  const AttentionTile({
    required this.item,
    this.awayActive = false,
    this.raised = false,
    this.onOpen,
    this.onWriteReply,
    this.tokenLabel,
    super.key,
  });

  @override
  ConsumerState<AttentionTile> createState() => _AttentionTileState();
}
class _AttentionTileState extends ConsumerState<AttentionTile> {
  bool _replying = false;
  bool _busy = false;
  final _replyController = TextEditingController();

  /// Expand state for [AttentionItem.text]: while collapsed the card shows
  /// the (possibly clipped) `item.text` at 4 lines; expanding shows the full
  /// text once [_fullText] arrives (fetched via `GET /attention/:id` — see
  /// [AttentionNotifier.fetchFullItem]), and the clipped text until then.
  bool _textExpanded = false;
  String? _fullText;

  /// The full (unclipped) `question` for a `kind: question` item whose
  /// compact strings looked truncated — same fetch-on-demand idea as
  /// [_fullText], triggered as soon as the tile is built rather than on a
  /// separate expand tap, since there's no other affordance to hang it off.
  QuestionSet? _fullQuestion;

  /// Which option index is mid-flight for a `choose` reply, so only that
  /// button shows "Sending…" and the others stay put until it resolves.
  int? _choosingIndex;

  @override
  void initState() {
    super.initState();
    _maybeFetchFullQuestion(widget.item);
  }

  @override
  void didUpdateWidget(covariant AttentionTile oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.item.id != widget.item.id || oldWidget.item.version != widget.item.version) {
      _fullText = null;
      _textExpanded = false;
      _fullQuestion = null;
      _maybeFetchFullQuestion(widget.item);
    }
  }

  @override
  void dispose() {
    _replyController.dispose();
    super.dispose();
  }

  Future<void> _run(Future<ActionResult> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    final result = await action();
    if (!mounted) return;
    setState(() => _busy = false);
    if (!result.success) {
      final message = switch (result.error) {
        'stale' => 'This item changed — refreshing.',
        'gone' => 'That agent session has ended.',
        _ => result.error ?? 'Action failed.',
      };
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
      unawaited(ref.read(attentionProvider.notifier).refresh());
    }
  }

  Future<void> _toggleTextExpand(AttentionItem item) async {
    setState(() => _textExpanded = !_textExpanded);
    if (_textExpanded && _fullText == null) {
      final full = await ref.read(attentionProvider.notifier).fetchFullItem(item);
      if (mounted && full != null) setState(() => _fullText = full.text);
    }
  }

  /// True if any string inside [question] looks like the compact snapshot's
  /// ~120-char clip truncated it.
  bool _questionLooksClipped(QuestionSet? question) {
    if (question == null) return false;
    for (final q in question.questions) {
      if (looksClipped(q.question, kCompactQuestionClipLength)) return true;
      if (q.header != null && looksClipped(q.header!, kCompactQuestionClipLength)) return true;
      for (final o in q.options) {
        if (looksClipped(o.label, kCompactQuestionClipLength)) return true;
        if (o.description != null && looksClipped(o.description!, kCompactQuestionClipLength)) return true;
      }
    }
    return false;
  }

  void _maybeFetchFullQuestion(AttentionItem item) {
    if (item.kind != AttentionKind.question) return;
    if (!_questionLooksClipped(item.question)) return;
    unawaited(_fetchFullQuestion(item));
  }

  Future<void> _fetchFullQuestion(AttentionItem item) async {
    final full = await ref.read(attentionProvider.notifier).fetchFullItem(item);
    if (mounted && full?.question != null) setState(() => _fullQuestion = full!.question);
  }

  Future<void> _choose(AttentionItem item, int index) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _choosingIndex = index;
    });
    final result = await ref
        .read(attentionProvider.notifier)
        .reply(item.id, action: 'choose', choice: index, version: item.version);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _choosingIndex = null;
    });
    if (!result.success) {
      final message = switch (result.error) {
        'stale' => 'This item changed — refreshing.',
        'gone' => 'That agent session has ended.',
        _ => result.error ?? 'Action failed.',
      };
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
      unawaited(ref.read(attentionProvider.notifier).refresh());
    }
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final notifier = ref.read(attentionProvider.notifier);
    final isQuestion = item.kind == AttentionKind.question;
    final legacyAskQuestion = item.isLegacyAskQuestionApproval;
    final isApproval = item.canApproveDeny && !legacyAskQuestion;
    final chips = item.canReply && _chipKinds.contains(item.kind) && !isQuestion;

    final meta = [
      if (item.sourceLabel.isNotEmpty) item.sourceLabel,
      if (widget.tokenLabel != null && widget.tokenLabel!.isNotEmpty) widget.tokenLabel!,
    ].join(' · ');

    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Meta line: the needs-you dot, the title, the age on the right.
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: WorkDot(item.severity == AttentionSeverity.ambient ? DotKind.idle : DotKind.needs),
            ),
            const SizedBox(width: AeronautTheme.spacingSm),
            Expanded(
              child: Text(
                item.title,
                style: AeronautTheme.subheadline.copyWith(fontWeight: FontWeight.w600),
              ),
            ),
            if (item.parked)
              const Padding(
                padding: EdgeInsets.only(left: 4),
                child: PhosphorIcon(PhosphorIcons.clock, size: 14, color: AeronautColors.textTertiary),
              ),
            const SizedBox(width: 4),
            Text(_age(item.createdAt), style: AeronautTheme.caption2),
            _MoreMenu(
              item: item,
              awayActive: widget.awayActive,
              busy: _busy,
              onSnooze: () => unawaited(_showSnoozeMenu(context, notifier, item)),
              onDismiss: () => _run(() => notifier.dismiss(item.id)),
              onWake: () => _run(() => notifier.setWake(item.id, !item.wake)),
              onOpenTab: () => _run(() => notifier.open(item.id)),
            ),
          ],
        ),
        if (meta.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(left: 15),
            child: Text(meta, style: AeronautTheme.caption1.copyWith(color: AeronautColors.textTertiary)),
          ),
        if (isQuestion) ...[
          const SizedBox(height: AeronautTheme.spacingSm),
          _QuestionBody(
            question: _fullQuestion ?? item.question,
            // Lee only puts `choose` in `actions` for a single-select,
            // single-question, option-preview-free question — trust that
            // over guessing from shape alone (it's the server's call, not
            // ours: C3).
            canChoose: item.canChoose,
            busy: _busy,
            choosingIndex: _choosingIndex,
            onChoose: (i) => unawaited(_choose(item, i)),
            onOpenTab: () => _run(() => notifier.open(item.id)),
          ),
        ],
        if (isApproval && item.tool != null && item.tool!.preview.isNotEmpty) ...[
          const SizedBox(height: AeronautTheme.spacingSm),
          _CommandPreview(item.tool!.preview),
        ],
        if (!isQuestion && item.text.isNotEmpty) ...[
          const SizedBox(height: AeronautTheme.spacingSm),
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => unawaited(_toggleTextExpand(item)),
            child: Text(
              _textExpanded && _fullText != null ? _fullText! : item.text,
              style: AeronautTheme.footnote,
              maxLines: _textExpanded ? null : 6,
              overflow: _textExpanded ? TextOverflow.visible : TextOverflow.ellipsis,
            ),
          ),
        ],
        if (legacyAskQuestion) ...[
          const SizedBox(height: AeronautTheme.spacingSm),
          Text(
            'Claude is asking a question — open the tab to answer.',
            style: AeronautTheme.footnote.copyWith(color: AeronautColors.textSecondary),
          ),
          const SizedBox(height: AeronautTheme.spacingSm),
          WorkButton(
            label: 'Open tab',
            kind: BtnKind.plain,
            busy: _busy,
            onPressed: () => _run(() => notifier.open(item.id)),
          ),
        ],
        if (isApproval) ...[
          const SizedBox(height: AeronautTheme.spacingMd),
          // Allow and Deny: explicit 44px taps, never a swipe (C3). Allow is
          // the view's one phosphor control only on the raised card.
          Row(
            children: [
              Expanded(
                child: WorkButton(
                  key: const ValueKey('attention-allow'),
                  label: 'Allow',
                  kind: widget.raised ? BtnKind.next : BtnKind.plain,
                  busy: _busy,
                  onPressed: () => _run(() => notifier.reply(item.id, action: 'approve', version: item.version)),
                ),
              ),
              const SizedBox(width: AeronautTheme.spacingSm),
              Expanded(
                child: WorkButton(
                  key: const ValueKey('attention-deny'),
                  label: 'Deny',
                  kind: BtnKind.plain,
                  busy: _busy,
                  onPressed: () => _run(() => notifier.reply(item.id, action: 'deny', version: item.version)),
                ),
              ),
            ],
          ),
        ],
        if (chips && !_replying) ...[
          const SizedBox(height: AeronautTheme.spacingMd),
          // Quick replies in a sideways scroll (§4.4: the card shows the
          // first three). A chip sends at once, through the same Reply path
          // as typed text.
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final chip in quickReplyChips.take(3)) ...[
                  QuickChip(
                    label: chip,
                    onTap: _busy ? null : () => _sendText(chip),
                  ),
                  const SizedBox(width: AeronautTheme.spacingSm),
                ],
              ],
            ),
          ),
        ],
        if (_replying) ...[
          const SizedBox(height: AeronautTheme.spacingSm),
          _ReplyField(
            controller: _replyController,
            busy: _busy,
            onCancel: () => setState(() => _replying = false),
            onSend: (text) {
              final trimmed = text.trim();
              if (trimmed.isEmpty) return;
              setState(() => _replying = false);
              _sendText(trimmed);
              _replyController.clear();
            },
          ),
        ] else if (item.canReply && !isQuestion)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              style: TextButton.styleFrom(
                foregroundColor: AeronautColors.textSecondary,
                padding: const EdgeInsets.symmetric(horizontal: 0, vertical: AeronautTheme.spacingSm),
                minimumSize: const Size(0, 44),
                textStyle: AeronautTheme.footnote,
              ),
              onPressed: _busy
                  ? null
                  : () => chips && widget.onWriteReply != null
                      ? widget.onWriteReply!()
                      : setState(() => _replying = true),
              child: Text(chips ? 'Write a reply…' : 'Reply'),
            ),
          ),
      ],
    );

    final card = WorkCard(raised: widget.raised, onOpen: widget.onOpen, child: body);

    const margin = EdgeInsets.symmetric(
      horizontal: AeronautTheme.spacingMd,
      vertical: AeronautTheme.spacingXs,
    );

    // Swipe actions (contracts §5.2: buttons and swipes over typing on the
    // phone). Snooze/dismiss only — approve/deny are never bound to a swipe
    // direction, whatever actions an item supports, so a stray gesture can
    // never approve something (C3).
    final swipeSnooze = item.canSnooze;
    final swipeDismiss = item.canDismiss;
    if (!swipeSnooze && !swipeDismiss) {
      return Padding(padding: margin, child: card);
    }

    final direction = swipeSnooze && swipeDismiss
        ? DismissDirection.horizontal
        : swipeSnooze
            ? DismissDirection.startToEnd
            : DismissDirection.endToStart;

    return Padding(
      padding: margin,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
        child: Dismissible(
          key: ValueKey('attention-${item.id}'),
          direction: direction,
          background: swipeSnooze
              ? const _SwipeIndicator(
                  icon: PhosphorIcons.clock,
                  label: 'Snooze',
                  color: AeronautColors.textSecondary,
                  alignRight: false,
                )
              : const SizedBox.shrink(),
          secondaryBackground: swipeDismiss
              ? const _SwipeIndicator(
                  icon: PhosphorIcons.trash,
                  label: 'Dismiss',
                  color: AeronautColors.offline,
                  alignRight: true,
                )
              : const SizedBox.shrink(),
          confirmDismiss: (dismissDirection) async {
            if (dismissDirection == DismissDirection.startToEnd) {
              await _showSnoozeMenu(context, notifier, item);
            } else {
              await _run(() => notifier.dismiss(item.id));
            }
            // Never actually remove the tile here — same as the Snooze/
            // Dismiss menu entries, the queue only drops it once the
            // server confirms (next snapshot/refresh).
            return false;
          },
          child: card,
        ),
      ),
    );
  }

  void _sendText(String text) {
    final item = widget.item;
    _run(() => ref.read(attentionProvider.notifier).reply(item.id, action: 'text', text: text, version: item.version));
  }
  Future<void> _showSnoozeMenu(BuildContext context, AttentionNotifier notifier, AttentionItem item) {
    return showModalBottomSheet<void>(
      context: context,
      backgroundColor: AeronautColors.bgElevated,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              title: const Text('Snooze 15 minutes'),
              onTap: () {
                Navigator.pop(ctx);
                _run(() => notifier.snooze(item.id, minutes: 15));
              },
            ),
            ListTile(
              title: const Text('Snooze 1 hour'),
              onTap: () {
                Navigator.pop(ctx);
                _run(() => notifier.snooze(item.id, minutes: 60));
              },
            ),
            ListTile(
              title: const Text('Until it changes'),
              onTap: () {
                Navigator.pop(ctx);
                _run(() => notifier.snooze(item.id, until: 'change'));
              },
            ),
          ],
        ),
      ),
    );
  }
}


/// `Xs` / `Xm` / `Xh` / `Xd` — no `intl` dependency for one small label.
String _age(DateTime? createdAt) {
  if (createdAt == null) return '';
  final diff = DateTime.now().toUtc().difference(createdAt.toUtc());
  if (diff.inSeconds < 60) return '${diff.inSeconds}s';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m';
  if (diff.inHours < 24) return '${diff.inHours}h';
  return '${diff.inDays}d';
}

enum _MoreAction { snooze, dismiss, wake, openTab }

/// The card's quiet `⋯` menu: snooze, dismiss, wake me and open the tab —
/// the same actions a swipe reaches, for when a swipe isn't handy.
class _MoreMenu extends StatelessWidget {
  final AttentionItem item;
  final bool awayActive;
  final bool busy;
  final VoidCallback onSnooze;
  final VoidCallback onDismiss;
  final VoidCallback onWake;
  final VoidCallback onOpenTab;

  const _MoreMenu({
    required this.item,
    required this.awayActive,
    required this.busy,
    required this.onSnooze,
    required this.onDismiss,
    required this.onWake,
    required this.onOpenTab,
  });

  @override
  Widget build(BuildContext context) {
    final entries = <PopupMenuEntry<_MoreAction>>[
      if (item.canSnooze) const PopupMenuItem(value: _MoreAction.snooze, child: Text('Snooze')),
      if (item.canDismiss) const PopupMenuItem(value: _MoreAction.dismiss, child: Text('Dismiss')),
      if (awayActive && item.canWake)
        PopupMenuItem(value: _MoreAction.wake, child: Text(item.wake ? 'Stop waking me' : 'Wake me')),
      if (item.actions.contains(AttentionActionName.open))
        const PopupMenuItem(value: _MoreAction.openTab, child: Text('Open tab on the Mac')),
    ];
    if (entries.isEmpty) return const SizedBox(width: 4);
    return SizedBox(
      width: 32,
      height: 24,
      child: PopupMenuButton<_MoreAction>(
        tooltip: 'More',
        enabled: !busy,
        padding: EdgeInsets.zero,
        color: AeronautColors.bgElevated,
        icon: const PhosphorIcon(PhosphorIcons.more, size: 18, color: AeronautColors.textTertiary),
        onSelected: (action) => switch (action) {
          _MoreAction.snooze => onSnooze(),
          _MoreAction.dismiss => onDismiss(),
          _MoreAction.wake => onWake(),
          _MoreAction.openTab => onOpenTab(),
        },
        itemBuilder: (_) => entries,
      ),
    );
  }
}

/// The exact command or preview an approval would run, in mono.
class _CommandPreview extends StatelessWidget {
  final String text;

  const _CommandPreview(this.text);

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AeronautTheme.spacingSm),
      decoration: BoxDecoration(
        color: AeronautColors.chrome,
        borderRadius: BorderRadius.circular(AeronautTheme.radiusSm),
      ),
      child: Text(
        text,
        maxLines: 6,
        overflow: TextOverflow.ellipsis,
        style: AeronautTheme.mono.copyWith(fontSize: 12, color: AeronautColors.textSecondary),
      ),
    );
  }
}
/// Body of a `kind: question` tile (Claude's `AskUserQuestion`). Shows a
/// tappable button per option only when [canChoose] is true — Lee sets
/// `choose` in `actions` only for a single, single-select question with
/// options and no option previews, and that's the server's call to make,
/// not a shape guess on this side (C3). Anything else (including the shape
/// not qualifying) falls back to a read-only view of whatever question text
/// is available, plus an "Open tab" action.
class _QuestionBody extends StatelessWidget {
  final QuestionSet? question;
  final bool canChoose;
  final bool busy;
  final int? choosingIndex;
  final ValueChanged<int> onChoose;
  final VoidCallback onOpenTab;

  const _QuestionBody({
    required this.question,
    required this.canChoose,
    required this.busy,
    required this.choosingIndex,
    required this.onChoose,
    required this.onOpenTab,
  });

  @override
  Widget build(BuildContext context) {
    final answerable = canChoose ? question?.singleAnswerable : null;
    if (answerable != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (answerable.header != null && answerable.header!.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                answerable.header!,
                style: AeronautTheme.caption1.copyWith(
                  color: AeronautColors.textTertiary,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          Text(answerable.question, style: AeronautTheme.footnote),
          for (var i = 0; i < answerable.options.length; i++)
            _QuestionOptionButton(
              option: answerable.options[i],
              sending: choosingIndex == i,
              disabled: busy,
              onTap: () => onChoose(i),
            ),
        ],
      );
    }

    // Read-only: not offered as a tap-to-choose (multi-question,
    // multi-select, options with previews, or Lee simply didn't offer
    // `choose`) — show whatever question text is available and steer to
    // the desktop for the actual answer.
    final questions = question?.questions ?? const <Question>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (questions.isEmpty)
          Text(
            'Claude is asking a question — open the tab to answer.',
            style: AeronautTheme.footnote.copyWith(color: AeronautColors.textSecondary),
          )
        else
          for (final q in questions) ...[
            if (q.header != null && q.header!.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(
                  q.header!,
                  style: AeronautTheme.caption1.copyWith(
                    color: AeronautColors.textTertiary,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            Padding(
              padding: const EdgeInsets.only(bottom: AeronautTheme.spacingXs),
              child: Text(q.question, style: AeronautTheme.footnote),
            ),
          ],
        const SizedBox(height: AeronautTheme.spacingSm),
        WorkButton(label: 'Open tab', kind: BtnKind.plain, busy: busy, onPressed: onOpenTab),
      ],
    );
  }
}

/// One tappable option row. Tapping sends `choose` immediately (contracts
/// §5.2: buttons over typing) and shows a brief "sending" state on that
/// option only, so the choice made is never ambiguous (C3).
class _QuestionOptionButton extends StatelessWidget {
  final QuestionOption option;
  final bool sending;
  final bool disabled;
  final VoidCallback onTap;

  const _QuestionOptionButton({
    required this.option,
    required this.sending,
    required this.disabled,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: AeronautTheme.spacingXs),
      child: Material(
        color: AeronautColors.bgElevated,
        borderRadius: BorderRadius.circular(AeronautTheme.radiusSm),
        child: InkWell(
          borderRadius: BorderRadius.circular(AeronautTheme.radiusSm),
          onTap: disabled ? null : onTap,
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(
              horizontal: AeronautTheme.spacingMd,
              vertical: AeronautTheme.spacingSm,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        option.label,
                        style: AeronautTheme.footnote.copyWith(fontWeight: FontWeight.w600),
                      ),
                      if (option.description != null && option.description!.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            option.description!,
                            style: AeronautTheme.caption1.copyWith(color: AeronautColors.textTertiary),
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: AeronautTheme.spacingSm),
                if (sending)
                  const SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                else
                  const PhosphorIcon(PhosphorIcons.chevronRight, size: 14, color: AeronautColors.textTertiary),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The colored panel revealed behind a tile while swiping (contracts §5.2).
/// Same rounded shape as the card (clipped by the caller) so it reads as
/// "underneath the card", not a full-bleed row.
class _SwipeIndicator extends StatelessWidget {
  final PhosphorIconData icon;
  final String label;
  final Color color;
  final bool alignRight;

  const _SwipeIndicator({
    required this.icon,
    required this.label,
    required this.color,
    required this.alignRight,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      alignment: alignRight ? Alignment.centerRight : Alignment.centerLeft,
      padding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingLg),
      color: color.withValues(alpha: 0.18),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (alignRight) ...[
            Text(
              label,
              style: AeronautTheme.footnote.copyWith(color: color, fontWeight: FontWeight.w600),
            ),
            const SizedBox(width: AeronautTheme.spacingSm),
          ],
          PhosphorIcon(icon, size: 18, color: color),
          if (!alignRight) ...[
            const SizedBox(width: AeronautTheme.spacingSm),
            Text(
              label,
              style: AeronautTheme.footnote.copyWith(color: color, fontWeight: FontWeight.w600),
            ),
          ],
        ],
      ),
    );
  }
}

/// The card's inline reply field (for items without a one-agent screen).
class _ReplyField extends StatelessWidget {
  final TextEditingController controller;
  final bool busy;
  final VoidCallback onCancel;
  final ValueChanged<String> onSend;

  const _ReplyField({
    required this.controller,
    required this.busy,
    required this.onCancel,
    required this.onSend,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: TextField(
            controller: controller,
            autofocus: true,
            minLines: 1,
            maxLines: 4,
            textInputAction: TextInputAction.send,
            onSubmitted: onSend,
            decoration: const InputDecoration(hintText: 'Reply…', isDense: true),
          ),
        ),
        IconButton(
          tooltip: 'Send',
          icon: const PhosphorIcon(PhosphorIcons.send, size: 18),
          onPressed: busy ? null : () => onSend(controller.text),
        ),
        IconButton(
          tooltip: 'Cancel',
          icon: const PhosphorIcon(PhosphorIcons.close, size: 18),
          onPressed: onCancel,
        ),
      ],
    );
  }
}
