import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:xterm/xterm.dart';

import '../models/lee_context.dart';
import '../providers/pty_provider.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';

/// Terminal screen with real terminal emulation via xterm.dart.
///
/// Renders full TUI apps (lazygit, Claude Code, htop) correctly
/// with proper escape sequence handling, cursor positioning,
/// alternate screen buffer, and colors.
class TerminalScreen extends ConsumerStatefulWidget {
  final TabContext tab;

  const TerminalScreen({required this.tab, super.key});

  static final terminalTheme = TerminalTheme(
    cursor: AeronautColors.accent,
    selection: AeronautColors.accent.withValues(alpha: 0.3),
    foreground: AeronautColors.textPrimary,
    background: AeronautColors.bgPrimary,
    black: const Color(0xFF484F58),
    red: const Color(0xFFFF7B72),
    green: AeronautColors.accent,
    yellow: const Color(0xFFD29922),
    blue: const Color(0xFF58A6FF),
    magenta: const Color(0xFFBC8CFF),
    cyan: const Color(0xFF39C5CF),
    white: AeronautColors.textPrimary,
    brightBlack: const Color(0xFF6E7681),
    brightRed: const Color(0xFFFFA198),
    brightGreen: const Color(0xFF56D364),
    brightYellow: const Color(0xFFE3B341),
    brightBlue: const Color(0xFF79C0FF),
    brightMagenta: const Color(0xFFD2A8FF),
    brightCyan: const Color(0xFF56D4DD),
    brightWhite: const Color(0xFFFFFFFF),
    searchHitBackground: const Color(0xFF58A6FF),
    searchHitBackgroundCurrent: AeronautColors.accent,
    searchHitForeground: AeronautColors.bgPrimary,
  );

  @override
  ConsumerState<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends ConsumerState<TerminalScreen> {
  final ScrollController _scrollController = ScrollController();

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ptyId = widget.tab.ptyId;

    if (ptyId == null) {
      return _NoPtyView(tab: widget.tab);
    }

    final ptyState = ref.watch(ptyProvider(ptyId));

    return Column(
      children: [
        Expanded(
          child: TerminalView(
            ptyState.terminal,
            theme: TerminalScreen.terminalTheme,
            textStyle: const TerminalStyle(
              fontSize: 13,
              fontFamily: 'JetBrainsMono',
            ),
            padding: const EdgeInsets.all(AeronautTheme.spacingSm),
            scrollController: _scrollController,
            deleteDetection: true,
            keyboardType: TextInputType.text,
          ),
        ),
        _ExtraKeysBar(terminal: ptyState.terminal),
        if (ptyState.exited)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(
              horizontal: AeronautTheme.spacingMd,
              vertical: AeronautTheme.spacingXs,
            ),
            color: AeronautColors.bgElevated,
            child: Text(
              'Process exited (code ${ptyState.exitCode ?? '?'})',
              style: AeronautTheme.caption.copyWith(
                color: ptyState.exitCode == 0
                    ? AeronautColors.accent
                    : AeronautColors.offline,
              ),
            ),
          ),
      ],
    );
  }
}

/// Extra key toolbar above the iOS keyboard for keys not on mobile keyboards.
///
/// Provides Esc, Tab, Ctrl, Alt, and arrow keys — essential for TUI apps
/// like Claude Code, lazygit, vim, etc.
class _ExtraKeysBar extends StatelessWidget {
  final Terminal terminal;

  const _ExtraKeysBar({required this.terminal});

  void _sendKey(TerminalKey key) {
    terminal.keyInput(key);
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      color: AeronautColors.bgElevated,
      padding: const EdgeInsets.symmetric(
        horizontal: AeronautTheme.spacingXs,
        vertical: 2,
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          _KeyButton(label: 'Enter', onTap: () => _sendKey(TerminalKey.enter)),
          _KeyButton(label: 'Esc', onTap: () => _sendKey(TerminalKey.escape)),
          const SizedBox(width: AeronautTheme.spacingSm),
          _KeyButton(label: '\u2190', onTap: () => _sendKey(TerminalKey.arrowLeft)),
          _KeyButton(label: '\u2193', onTap: () => _sendKey(TerminalKey.arrowDown)),
          _KeyButton(label: '\u2191', onTap: () => _sendKey(TerminalKey.arrowUp)),
          _KeyButton(label: '\u2192', onTap: () => _sendKey(TerminalKey.arrowRight)),
          const Spacer(),
          _KeyButton(label: 'Tab', onTap: () => _sendKey(TerminalKey.tab)),
        ],
      ),
    );
  }
}

class _KeyButton extends StatelessWidget {
  final String label;
  final VoidCallback onTap;

  const _KeyButton({required this.label, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 2),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: AeronautColors.bgSurface,
          borderRadius: BorderRadius.circular(4),
          border: Border.all(color: AeronautColors.border, width: 0.5),
        ),
        child: Text(
          label,
          style: AeronautTheme.mono.copyWith(
            fontSize: 12,
            color: AeronautColors.textSecondary,
          ),
        ),
      ),
    );
  }
}


/// Shown when a tab has no PTY ID.
class _NoPtyView extends StatelessWidget {
  final TabContext tab;

  const _NoPtyView({required this.tab});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(
            Icons.terminal,
            size: 48,
            color: AeronautColors.textTertiary,
          ),
          const SizedBox(height: AeronautTheme.spacingMd),
          Text(
            tab.label,
            style: AeronautTheme.heading.copyWith(
              color: AeronautColors.textSecondary,
            ),
          ),
          const SizedBox(height: AeronautTheme.spacingSm),
          Text(
            'No PTY attached',
            style: AeronautTheme.caption,
          ),
        ],
      ),
    );
  }
}
