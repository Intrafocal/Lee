import 'package:flutter/material.dart';

import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';

/// Regex to strip ANSI escape sequences from terminal output.
/// Covers CSI sequences, OSC sequences, cursor positioning, alternate screen buffer,
/// and other common escape patterns from TUI apps (lazygit, htop, etc.).
final _ansiRegex = RegExp(
  r'\x1B'          // ESC character
  r'(?:'
    r'\[[0-?]*[ -/]*[@-~]'       // CSI sequences (colors, cursor, erase, scroll, etc.)
    r'|\][^\x07\x1B]*(?:\x07|\x1B\\)'  // OSC sequences (title, clipboard, etc.)
    r'|[()][AB012]'               // Character set selection
    r'|\[[\d;]*[Hf]'             // Cursor positioning (redundant but explicit)
    r'|[78]'                      // Save/restore cursor (DECSC/DECRC)
    r'|[=>]'                      // Keypad modes
    r'|[cDEHMNOPVWXZ\\^_]'       // Various single-char escapes
    r'|\[\?[0-9;]*[hlsr]'        // Private mode set/reset (alt screen, cursor hide, etc.)
    r'|\[[0-9;]*[ABCDEFGHIJKLMST]'  // Cursor movement, erase, scroll
  r')',
);

/// Control characters that TUI apps use but shouldn't appear in plain text output.
final _controlChars = RegExp(r'[\x00-\x08\x0E-\x1A\x7F]');

/// Strips ANSI escape codes and control characters from text.
String stripAnsi(String text) {
  var cleaned = text.replaceAll(_ansiRegex, '');
  cleaned = cleaned.replaceAll(_controlChars, '');
  // Collapse multiple blank lines into at most two
  cleaned = cleaned.replaceAll(RegExp(r'\n{4,}'), '\n\n');
  return cleaned;
}

/// Scrollable monospace text view for terminal output.
///
/// Auto-scrolls to bottom on new data. Dark background with terminal green text.
class TerminalOutput extends StatefulWidget {
  final String text;

  const TerminalOutput({required this.text, super.key});

  @override
  State<TerminalOutput> createState() => _TerminalOutputState();
}

class _TerminalOutputState extends State<TerminalOutput> {
  final ScrollController _scrollController = ScrollController();
  bool _autoScroll = true;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final atBottom = _scrollController.offset >=
        _scrollController.position.maxScrollExtent - 50;
    _autoScroll = atBottom;
  }

  @override
  void didUpdateWidget(TerminalOutput oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_autoScroll && widget.text.length > oldWidget.text.length) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scrollController.hasClients) {
          _scrollController.jumpTo(
            _scrollController.position.maxScrollExtent,
          );
        }
      });
    }
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cleaned = stripAnsi(widget.text);

    return Container(
      color: AeronautColors.bgPrimary,
      child: SelectableText.rich(
        TextSpan(
          text: cleaned,
          style: AeronautTheme.mono.copyWith(
            color: AeronautColors.accent,
            fontSize: 12,
            height: 1.4,
          ),
        ),
        scrollPhysics: const ClampingScrollPhysics(),
        // ignore: deprecated_member_use
      ),
    );

    // Use a ListView for scrolling control
  }
}

/// Full terminal output view with proper scrolling.
class ScrollableTerminalOutput extends StatefulWidget {
  final String text;

  const ScrollableTerminalOutput({required this.text, super.key});

  @override
  State<ScrollableTerminalOutput> createState() =>
      _ScrollableTerminalOutputState();
}

class _ScrollableTerminalOutputState extends State<ScrollableTerminalOutput> {
  final ScrollController _scrollController = ScrollController();
  bool _autoScroll = true;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(() {
      if (!_scrollController.hasClients) return;
      _autoScroll = _scrollController.offset >=
          _scrollController.position.maxScrollExtent - 50;
    });
  }

  @override
  void didUpdateWidget(ScrollableTerminalOutput oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_autoScroll && widget.text.length > oldWidget.text.length) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scrollController.hasClients) {
          _scrollController.jumpTo(
            _scrollController.position.maxScrollExtent,
          );
        }
      });
    }
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cleaned = stripAnsi(widget.text);

    return Container(
      color: AeronautColors.bgPrimary,
      padding: const EdgeInsets.all(AeronautTheme.spacingSm),
      child: SingleChildScrollView(
        controller: _scrollController,
        child: SizedBox(
          width: double.infinity,
          child: Text(
            cleaned.isEmpty ? ' ' : cleaned,
            style: AeronautTheme.mono.copyWith(
              color: AeronautColors.accent,
              fontSize: 12,
              height: 1.4,
            ),
          ),
        ),
      ),
    );
  }
}
