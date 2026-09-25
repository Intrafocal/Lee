import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/hester_models.dart';
import '../models/lee_context.dart';
import '../providers/hester_provider.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import '../widgets/phosphor_icon.dart';
import '../widgets/react_phase_indicator.dart';
import 'bundles_screen.dart';
import 'sessions_screen.dart';

/// Hester chat screen with SSE streaming and ReAct phase visualization.
class HesterScreen extends ConsumerStatefulWidget {
  final TabContext? tab;

  const HesterScreen({this.tab, super.key});

  @override
  ConsumerState<HesterScreen> createState() => _HesterScreenState();
}

class _HesterScreenState extends ConsumerState<HesterScreen> {
  final _inputController = TextEditingController();
  final _scrollController = ScrollController();
  final _focusNode = FocusNode();

  @override
  void dispose() {
    _inputController.dispose();
    _scrollController.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _send() {
    final text = _inputController.text;
    if (text.trim().isEmpty) return;
    _inputController.clear();
    ref.read(hesterChatProvider.notifier).sendMessage(text);
    // Scroll to bottom after message is added
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scrollToBottom();
    });
  }

  void _scrollToBottom() {
    if (_scrollController.hasClients) {
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final chatState = ref.watch(hesterChatProvider);

    // Auto-scroll when messages change or streaming state changes
    ref.listen<HesterChatState>(hesterChatProvider, (prev, next) {
      if (prev?.messages.length != next.messages.length ||
          prev?.isStreaming != next.isStreaming) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          _scrollToBottom();
        });
      }
    });

    return Column(
      children: [
        // App bar actions row
        _ActionBar(
          onNewChat: () => ref.read(hesterChatProvider.notifier).newConversation(),
          onSessions: () => Navigator.of(context).push(
            MaterialPageRoute<void>(builder: (_) => const SessionsScreen()),
          ),
          onBundles: () => Navigator.of(context).push(
            MaterialPageRoute<void>(builder: (_) => const BundlesScreen()),
          ),
        ),

        // ReAct phase indicator
        ReActPhaseIndicator(phase: chatState.currentPhase),

        // Error banner
        if (chatState.error != null) _ErrorBanner(error: chatState.error!),

        // Messages
        Expanded(
          child: chatState.messages.isEmpty
              ? _EmptyState(tabLabel: widget.tab?.label ?? 'Hester')
              : ListView.builder(
                  controller: _scrollController,
                  padding: const EdgeInsets.symmetric(
                    horizontal: AeronautTheme.spacingMd,
                    vertical: AeronautTheme.spacingSm,
                  ),
                  itemCount: chatState.messages.length,
                  itemBuilder: (_, index) {
                    return _MessageBubble(
                      message: chatState.messages[index],
                    );
                  },
                ),
        ),

        // Input bar
        _InputBar(
          controller: _inputController,
          focusNode: _focusNode,
          isStreaming: chatState.isStreaming,
          onSend: _send,
        ),
      ],
    );
  }
}

/// Action bar with new chat, sessions, and bundles buttons.
class _ActionBar extends StatelessWidget {
  final VoidCallback onNewChat;
  final VoidCallback onSessions;
  final VoidCallback onBundles;

  const _ActionBar({
    required this.onNewChat,
    required this.onSessions,
    required this.onBundles,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 36,
      padding: const EdgeInsets.symmetric(
        horizontal: AeronautTheme.spacingSm,
      ),
      decoration: const BoxDecoration(
        color: AeronautColors.bgSurface,
        border: Border(
          bottom: BorderSide(color: AeronautColors.border),
        ),
      ),
      child: Row(
        children: [
          _ActionChip(
            icon: PhosphorIcons.plus,
            label: 'New',
            onTap: onNewChat,
          ),
          const SizedBox(width: AeronautTheme.spacingSm),
          _ActionChip(
            icon: PhosphorIcons.clock,
            label: 'Sessions',
            onTap: onSessions,
          ),
          const Spacer(),
          _ActionChip(
            // No package/box icon in the Phosphor set; kept as the closest
            // available role (folder) would be misleading, so this one stays
            // Material — see the design-pass report.
            icon: null,
            label: 'Bundles',
            onTap: onBundles,
          ),
        ],
      ),
    );
  }
}

class _ActionChip extends StatelessWidget {
  final PhosphorIconData? icon;
  final String label;
  final VoidCallback onTap;

  const _ActionChip({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AeronautTheme.radiusSm),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AeronautTheme.spacingSm,
          vertical: AeronautTheme.spacingXs,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            icon != null
                ? PhosphorIcon(icon!, size: 14, color: AeronautColors.textSecondary)
                : const PhosphorIcon(PhosphorIcons.package, size: 14, color: AeronautColors.textSecondary),
            const SizedBox(width: 4),
            Text(label, style: AeronautTheme.caption1),
          ],
        ),
      ),
    );
  }
}

/// Error banner shown when streaming fails.
class _ErrorBanner extends StatelessWidget {
  final String error;

  const _ErrorBanner({required this.error});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: AeronautTheme.spacingMd,
        vertical: AeronautTheme.spacingSm,
      ),
      color: AeronautColors.offline.withValues(alpha: 0.15),
      child: Text(
        error,
        style: AeronautTheme.caption1.copyWith(color: AeronautColors.offline),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }
}

/// Empty state shown when no messages yet.
class _EmptyState extends StatelessWidget {
  final String tabLabel;

  const _EmptyState({required this.tabLabel});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const PhosphorIcon(
            PhosphorIcons.hester,
            size: 48,
            color: AeronautColors.accent,
          ),
          const SizedBox(height: AeronautTheme.spacingMd),
          Text(tabLabel, style: AeronautTheme.headline),
          const SizedBox(height: AeronautTheme.spacingSm),
          const Text(
            'Ask Hester anything about your codebase',
            style: AeronautTheme.caption1,
          ),
        ],
      ),
    );
  }
}

/// A single chat message bubble.
class _MessageBubble extends StatelessWidget {
  final ChatMessage message;

  const _MessageBubble({required this.message});

  @override
  Widget build(BuildContext context) {
    final isUser = message.isUser;
    return Padding(
      padding: const EdgeInsets.only(bottom: AeronautTheme.spacingSm),
      child: Row(
        mainAxisAlignment:
            isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!isUser) ...[
            const _Avatar(isUser: false),
            const SizedBox(width: AeronautTheme.spacingSm),
          ],
          Flexible(
            child: Container(
              padding: const EdgeInsets.symmetric(
                horizontal: AeronautTheme.spacingMd,
                vertical: AeronautTheme.spacingSm,
              ),
              decoration: BoxDecoration(
                // Task spec: user bubbles are a flat ground5 fill, no
                // border; assistant stays on the surface plane with a
                // hairline border, as before.
                color: isUser ? AeronautColors.bgElevated : AeronautColors.bgSurface,
                borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
                border: isUser
                    ? null
                    : Border.all(color: AeronautColors.border),
              ),
              child: isUser
                  ? SelectableText(
                      message.content,
                      style: AeronautTheme.body,
                    )
                  : MarkdownBody(
                      data: message.content,
                      selectable: true,
                      onTapLink: (_, href, _) {
                        if (href != null) launchUrl(Uri.parse(href));
                      },
                      styleSheet: AeronautTheme.markdown(context),
                    ),
            ),
          ),
          if (isUser) ...[
            const SizedBox(width: AeronautTheme.spacingSm),
            const _Avatar(isUser: true),
          ],
        ],
      ),
    );
  }
}

/// Small avatar circle for user/assistant messages.
class _Avatar extends StatelessWidget {
  final bool isUser;

  const _Avatar({required this.isUser});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 28,
      height: 28,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: isUser ? AeronautColors.bgElevated : AeronautColors.accentMuted,
      ),
      child: PhosphorIcon(
        isUser ? PhosphorIcons.user : PhosphorIcons.hester,
        size: 16,
        color: isUser ? AeronautColors.textSecondary : AeronautColors.textPrimary,
      ),
    );
  }
}

/// Input bar at the bottom of the chat.
class _InputBar extends StatelessWidget {
  final TextEditingController controller;
  final FocusNode focusNode;
  final bool isStreaming;
  final VoidCallback onSend;

  const _InputBar({
    required this.controller,
    required this.focusNode,
    required this.isStreaming,
    required this.onSend,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AeronautTheme.spacingSm),
      decoration: const BoxDecoration(
        color: AeronautColors.bgSurface,
        border: Border(
          top: BorderSide(color: AeronautColors.border),
        ),
      ),
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: controller,
                focusNode: focusNode,
                enabled: !isStreaming,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => onSend(),
                maxLines: null,
                style: AeronautTheme.body,
                decoration: InputDecoration(
                  hintText: isStreaming ? 'Hester is thinking...' : 'Ask Hester...',
                  hintStyle: AeronautTheme.body.copyWith(
                    color: AeronautColors.textTertiary,
                  ),
                  border: InputBorder.none,
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: AeronautTheme.spacingSm,
                    vertical: AeronautTheme.spacingXs,
                  ),
                  isDense: true,
                ),
              ),
            ),
            if (isStreaming)
              const Padding(
                padding: EdgeInsets.all(8.0),
                child: SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator.adaptive(strokeWidth: 2),
                ),
              )
            else
              IconButton(
                icon: const PhosphorIcon(PhosphorIcons.send, color: AeronautColors.accent),
                onPressed: onSend,
              ),
          ],
        ),
      ),
    );
  }
}
