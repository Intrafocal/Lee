import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/activity.dart';
import '../models/attention.dart';
import '../providers/attention_provider.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import '../theme/phosphor_tokens.dart';
import '../widgets/attention_tile.dart';
import '../widgets/in_flight_section.dart';
import '../widgets/phosphor_icon.dart';
import '../widgets/work_ui.dart';

/// The item [AgentScreen] answers: [itemId] if it's still live, else the
/// agent's own live item (an approval or question first, then anything
/// that takes a reply).
AttentionItem? agentItem(AttentionSnapshot snapshot, {int? ptyId, String? itemId}) {
  final live = snapshot.items
      .where((i) => i.state == AttentionItemState.open || i.state == AttentionItemState.snoozed)
      .toList();
  if (itemId != null) {
    for (final i in live) {
      if (i.id == itemId) return i;
    }
  }
  if (ptyId == null) return null;
  final mine = live.where((i) => i.source.ptyId == ptyId).toList();
  for (final i in mine) {
    if (i.canApproveDeny || i.kind == AttentionKind.question) return i;
  }
  for (final i in mine) {
    if (i.canReply) return i;
  }
  return mine.isEmpty ? null : mine.first;
}

/// One agent (cockpit design §4.2, §8.1): its words as prose ("It asked" /
/// "It said"), the pending action, the four quick replies as a 2×2 grid,
/// Updates, "Along the way" (folded), and a reply bar pinned to the bottom
/// with a round phosphor Send. Replies go through the item's Reply; with no
/// open item the bar is disabled ("Reply from the Mac for now").
class AgentScreen extends ConsumerStatefulWidget {
  final int? ptyId;
  final String? itemId;

  /// Focus the reply field on open ("Write a reply…" on a waiting card).
  final bool focusReply;

  const AgentScreen({this.ptyId, this.itemId, this.focusReply = false, super.key});

  @override
  ConsumerState<AgentScreen> createState() => _AgentScreenState();
}

class _AgentScreenState extends ConsumerState<AgentScreen> {
  final _replyController = TextEditingController();
  final _replyFocus = FocusNode();
  bool _busy = false;

  /// Unclipped words, fetched on open when the compact snapshot clipped them.
  String? _fullText;
  String? _fullTextKey;

  @override
  void initState() {
    super.initState();
    if (widget.focusReply) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _replyFocus.requestFocus();
      });
    }
  }

  @override
  void dispose() {
    _replyController.dispose();
    _replyFocus.dispose();
    super.dispose();
  }

  /// Fetches the full item text, or the agent's full last message, once per
  /// version when the compact one looks clipped. A new item or message drops
  /// the text fetched for the old one, so it never shows under the new one.
  void _maybeFetchFull(AttentionItem? item, AgentSummary? agent) {
    final notifier = ref.read(attentionProvider.notifier);
    final summary = agent?.lastSummary;
    final String? key;
    final String text;
    if (item != null && item.text.isNotEmpty) {
      key = 'item:${item.id}:${item.version}';
      text = item.text;
    } else if (agent != null && summary != null) {
      key = 'agent:${agent.ptyId}:${summary.hashCode}';
      text = summary;
    } else {
      key = null;
      text = '';
    }
    if (_fullTextKey == key) return;
    _fullTextKey = key;
    _fullText = null;
    if (key == null || !looksClipped(text)) return;
    final Future<String?> fetch = key.startsWith('item:')
        ? notifier.fetchFullItem(item!).then((full) => full?.text)
        : notifier.fetchFullAgentSummary(agent!.ptyId).then((full) => full?.lastSummary);
    unawaited(fetch.then((full) {
      if (mounted && full != null && _fullTextKey == key) setState(() => _fullText = full);
    }));
  }

  Future<void> _run(Future<ActionResult> Function() action, {String? done}) async {
    if (_busy) return;
    setState(() => _busy = true);
    final result = await action();
    if (!mounted) return;
    setState(() => _busy = false);
    final messenger = ScaffoldMessenger.of(context);
    if (!result.success) {
      final message = switch (result.error) {
        'stale' => 'This item changed — refreshing.',
        'gone' => 'That agent session has ended.',
        _ => result.error ?? 'Action failed.',
      };
      messenger.showSnackBar(SnackBar(content: Text(message)));
      unawaited(ref.read(attentionProvider.notifier).refresh());
    } else if (done != null) {
      messenger.showSnackBar(SnackBar(content: Text(done)));
    }
  }

  void _sendText(AttentionItem item, String text) {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    _replyController.clear();
    unawaited(_run(
      () => ref.read(attentionProvider.notifier).reply(item.id, action: 'text', text: trimmed, version: item.version),
      done: 'Sent',
    ));
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = ref.watch(attentionProvider.select((s) => s.snapshot));
    AgentSummary? agent;
    final ptyId = widget.ptyId;
    if (ptyId != null) {
      for (final a in snapshot.agents) {
        if (a.ptyId == ptyId) agent = a;
      }
    }
    final item = agentItem(snapshot, ptyId: ptyId, itemId: widget.itemId);
    _maybeFetchFull(item, agent);

    if (agent == null && item == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Work')),
        body: const Center(child: QuietText('This agent has finished.')),
      );
    }

    final now = DateTime.now();
    final name = agent?.label ?? (item!.sourceLabel.isNotEmpty ? item.sourceLabel : item.title);
    final dot = item != null && item.severity != AttentionSeverity.ambient
        ? DotKind.needs
        : agentDot(agent?.state ?? AgentRunState.unknown);
    final workspaceName = agent?.workspaceName ?? item?.source.workspaceName;
    final usage = usageLine(agent?.usage);
    final meta = [
      if (agent != null && agent.provider.isNotEmpty) agent.provider,
      if (workspaceName != null) workspaceName,
      if (agent?.busySince != null) 'started ${shortDuration(now.difference(agent!.busySince!))} ago',
      if (item?.createdAt != null) 'waiting on you ${shortDuration(now.difference(item!.createdAt!))}',
      if (usage != null) usage,
    ].join(' · ');

    final asked = item != null && item.kind != AttentionKind.summary && item.kind != AttentionKind.failure;
    final rawWords = item != null && item.text.isNotEmpty ? item.text : (agent?.lastSummary ?? '');
    final words = (_fullText ?? rawWords).trim();
    final approval = item != null && item.canApproveDeny && !item.isLegacyAskQuestionApproval;
    final question = item != null && (item.kind == AttentionKind.question || item.isLegacyAskQuestionApproval);
    final canReply = item != null && item.canReply && !question;
    final updates = agent?.updates.reversed.toList() ?? const <AgentUpdate>[];
    final recent = agent?.recent.reversed.toList() ?? const <AgentActivity>[];
    final notifier = ref.read(attentionProvider.notifier);

    return Scaffold(
      appBar: AppBar(title: const Text('Work')),
      body: Column(
        children: [
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(
                AeronautTheme.spacingMd,
                AeronautTheme.spacingSm,
                AeronautTheme.spacingMd,
                AeronautTheme.spacingLg,
              ),
              children: [
                Row(
                  children: [
                    WorkDot(dot),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        name,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w500, color: Phosphor.text1),
                      ),
                    ),
                  ],
                ),
                if (meta.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(meta, style: AeronautTheme.footnote.copyWith(color: AeronautColors.textTertiary)),
                ],
                if (agent != null && agent.state == AgentRunState.busy) ...[
                  const SizedBox(height: 4),
                  Text(agentSubLine(agent), style: AeronautTheme.footnote.copyWith(color: AeronautColors.textSecondary)),
                ],
                if (item != null && item.title.isNotEmpty && item.title != name) ...[
                  const SizedBox(height: AeronautTheme.spacingMd),
                  Text(item.title, style: AeronautTheme.subheadline.copyWith(fontWeight: FontWeight.w600)),
                ],
                if (words.isNotEmpty) ...[
                  _Label(asked ? 'It asked' : 'It said'),
                  MarkdownBody(
                    data: words,
                    selectable: true,
                    onTapLink: (_, href, _) {
                      if (href != null) launchUrl(Uri.parse(href));
                    },
                    styleSheet: AeronautTheme.markdown(context).copyWith(
                      p: const TextStyle(fontSize: 16, height: 1.45, color: Phosphor.text1),
                    ),
                  ),
                ],
                if (approval) ...[
                  const SizedBox(height: AeronautTheme.spacingMd),
                  if (item.tool != null && item.tool!.preview.isNotEmpty)
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(AeronautTheme.spacingSm),
                      margin: const EdgeInsets.only(bottom: AeronautTheme.spacingSm),
                      decoration: BoxDecoration(
                        color: AeronautColors.chrome,
                        borderRadius: BorderRadius.circular(AeronautTheme.radiusSm),
                      ),
                      child: SelectableText(
                        item.tool!.preview,
                        style: AeronautTheme.mono.copyWith(fontSize: 12, color: AeronautColors.textSecondary),
                      ),
                    ),
                  Row(
                    children: [
                      Expanded(
                        child: WorkButton(
                          key: const ValueKey('agent-allow'),
                          label: 'Allow',
                          kind: BtnKind.next,
                          height: 48,
                          busy: _busy,
                          onPressed: () => _run(() => notifier.reply(item.id, action: 'approve', version: item.version)),
                        ),
                      ),
                      const SizedBox(width: AeronautTheme.spacingSm),
                      Expanded(
                        child: WorkButton(
                          key: const ValueKey('agent-deny'),
                          label: 'Deny',
                          height: 48,
                          busy: _busy,
                          onPressed: () => _run(() => notifier.reply(item.id, action: 'deny', version: item.version)),
                        ),
                      ),
                    ],
                  ),
                ],
                if (question) ...[
                  const SizedBox(height: AeronautTheme.spacingMd),
                  // The question card already answers options and legacy
                  // asks safely (C3); reuse it rather than a second copy.
                  AttentionTile(item: item, awayActive: snapshot.away.active),
                ],
                const _Label('Quick replies'),
                _QuickReplyGrid(
                  enabled: canReply && !_busy,
                  onReply: (text) => _sendText(item!, text),
                ),
                if (updates.isNotEmpty) ...[
                  const _Label('Updates'),
                  for (final u in updates) _UpdateRow(update: u),
                ],
                if (recent.isNotEmpty)
                  Theme(
                    data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                    child: ExpansionTile(
                      key: const ValueKey('along-the-way'),
                      tilePadding: EdgeInsets.zero,
                      childrenPadding: EdgeInsets.zero,
                      iconColor: AeronautColors.textTertiary,
                      collapsedIconColor: AeronautColors.textTertiary,
                      title: Text(
                        'Along the way',
                        style: AeronautTheme.footnote.copyWith(color: AeronautColors.textSecondary),
                      ),
                      children: [
                        for (final e in recent)
                          Padding(
                            padding: const EdgeInsets.symmetric(vertical: 3),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                SizedBox(
                                  width: 48,
                                  child: Text(_clock(e.at), style: AeronautTheme.caption1.copyWith(color: AeronautColors.textTertiary)),
                                ),
                                Expanded(
                                  child: Text(
                                    e.phase == 'pre'
                                        ? describeActivity(tool: e.tool, preview: e.preview, files: e.files, failed: e.failed)
                                        : describePast(e),
                                    style: AeronautTheme.footnote.copyWith(color: AeronautColors.textSecondary),
                                  ),
                                ),
                              ],
                            ),
                          ),
                      ],
                    ),
                  ),
                if (agent != null && agent.tabId != null) ...[
                  const Divider(height: AeronautTheme.spacingLg),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton(
                      style: TextButton.styleFrom(foregroundColor: AeronautColors.textSecondary),
                      onPressed: () => unawaited(openAgentTab(ref, agent!)),
                      child: const Text('Open its tab'),
                    ),
                  ),
                ],
              ],
            ),
          ),
          _ReplyBar(
            controller: _replyController,
            focusNode: _replyFocus,
            enabled: canReply,
            busy: _busy,
            // Allow is the one next step while an approval is pending (§0 rule 1).
            primary: !approval,
            onSend: canReply ? (text) => _sendText(item, text) : null,
          ),
        ],
      ),
    );
  }
}

/// "14:05" in local time.
String _clock(DateTime? at) {
  if (at == null) return '';
  final t = at.toLocal();
  return '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
}

class _Label extends StatelessWidget {
  final String text;

  const _Label(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: AeronautTheme.spacingLg, bottom: AeronautTheme.spacingSm),
      child: Text(
        text.toUpperCase(),
        style: const TextStyle(fontSize: 12, letterSpacing: 0.72, fontWeight: FontWeight.w500, color: Phosphor.text3),
      ),
    );
  }
}

/// The four quick replies as a 2×2 grid of 48px buttons.
class _QuickReplyGrid extends StatelessWidget {
  final bool enabled;
  final ValueChanged<String> onReply;

  const _QuickReplyGrid({required this.enabled, required this.onReply});

  @override
  Widget build(BuildContext context) {
    Widget cell(String text) => Expanded(
          child: WorkButton(
            label: text,
            height: 48,
            onPressed: enabled ? () => onReply(text) : null,
          ),
        );
    return Column(
      children: [
        Row(children: [cell(quickReplyChips[0]), const SizedBox(width: AeronautTheme.spacingSm), cell(quickReplyChips[1])]),
        const SizedBox(height: AeronautTheme.spacingSm),
        Row(children: [cell(quickReplyChips[2]), const SizedBox(width: AeronautTheme.spacingSm), cell(quickReplyChips[3])]),
      ],
    );
  }
}

class _UpdateRow extends StatelessWidget {
  final AgentUpdate update;

  const _UpdateRow({required this.update});

  @override
  Widget build(BuildContext context) {
    final status = update.leeStatus;
    final text = (update.summary?.trim().isNotEmpty ?? false) ? update.summary!.trim() : (status?.summary ?? '');
    final next = status?.next;
    return Padding(
      padding: const EdgeInsets.only(bottom: AeronautTheme.spacingSm),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 48,
            child: Text(_clock(update.at), style: AeronautTheme.caption1.copyWith(color: AeronautColors.textTertiary)),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (text.isNotEmpty)
                  Text(text, maxLines: 4, overflow: TextOverflow.ellipsis, style: AeronautTheme.footnote),
                if (next != null && next.isNotEmpty)
                  Text('Next: $next', style: AeronautTheme.caption1.copyWith(color: AeronautColors.textTertiary)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The reply bar pinned to the bottom: a field and a round Send.
class _ReplyBar extends StatelessWidget {
  final TextEditingController controller;
  final FocusNode focusNode;
  final bool enabled;
  final bool busy;
  final bool primary;
  final ValueChanged<String>? onSend;

  const _ReplyBar({
    required this.controller,
    required this.focusNode,
    required this.enabled,
    required this.busy,
    required this.primary,
    required this.onSend,
  });

  @override
  Widget build(BuildContext context) {
    final canSend = enabled && !busy && onSend != null;
    return Container(
      decoration: const BoxDecoration(
        color: AeronautColors.chrome,
        border: Border(top: BorderSide(color: AeronautColors.border, width: 0.5)),
      ),
      padding: const EdgeInsets.fromLTRB(AeronautTheme.spacingMd, AeronautTheme.spacingSm, AeronautTheme.spacingSm, AeronautTheme.spacingSm),
      child: SafeArea(
        top: false,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: TextField(
                key: const ValueKey('agent-reply-field'),
                controller: controller,
                focusNode: focusNode,
                enabled: enabled,
                minLines: 1,
                maxLines: 5,
                textInputAction: TextInputAction.newline,
                decoration: InputDecoration(
                  hintText: enabled ? 'Or write a reply' : 'Reply from the Mac for now',
                  isDense: true,
                ),
              ),
            ),
            const SizedBox(width: AeronautTheme.spacingSm),
            SizedBox(
              width: 44,
              height: 44,
              child: Material(
                shape: const CircleBorder(),
                color: !canSend
                    ? Phosphor.ground4
                    : primary
                        ? Phosphor.phosphor
                        : Phosphor.ground5,
                child: InkWell(
                  key: const ValueKey('agent-send'),
                  customBorder: const CircleBorder(),
                  onTap: canSend ? () => onSend!(controller.text) : null,
                  child: Center(
                    child: busy
                        ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                        : PhosphorIcon(
                            PhosphorIcons.send,
                            size: 20,
                            color: canSend && primary ? Phosphor.onPhosphor : Phosphor.text2,
                          ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
