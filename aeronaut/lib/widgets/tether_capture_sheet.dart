import 'package:flutter/material.dart';

import '../models/voice.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import 'voice_button.dart';
import 'work_ui.dart';

/// A bottom sheet with one Newsreader field ("Capture a thought into
/// this") and the mic. [onCapture] gets the text and whether it came by
/// voice; the sheet closes when it returns true and keeps the words when
/// it doesn't.
Future<void> showTetherCaptureSheet(
  BuildContext context, {
  required String title,
  required Future<bool> Function(String text, bool voice) onCapture,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _TetherCaptureSheet(title: title, onCapture: onCapture),
  );
}

class _TetherCaptureSheet extends StatefulWidget {
  final String title;
  final Future<bool> Function(String text, bool voice) onCapture;

  const _TetherCaptureSheet({required this.title, required this.onCapture});

  @override
  State<_TetherCaptureSheet> createState() => _TetherCaptureSheetState();
}

class _TetherCaptureSheetState extends State<_TetherCaptureSheet> {
  static const _field = 'tether-capture';
  final _controller = TextEditingController();
  final _focus = FocusNode();
  bool _busy = false;
  bool _voice = false;

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final text = _controller.text.trim();
    if (text.isEmpty || _busy) return;
    setState(() => _busy = true);
    final navigator = Navigator.of(context);
    final ok = await widget.onCapture(text, _voice);
    if (!mounted) return;
    setState(() => _busy = false);
    // Keep the sheet (and the words) on failure, so nothing is lost.
    if (ok) navigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Container(
        padding: const EdgeInsets.fromLTRB(
          AeronautTheme.spacingMd,
          AeronautTheme.spacingMd,
          AeronautTheme.spacingMd,
          AeronautTheme.spacingLg,
        ),
        decoration: const BoxDecoration(
          color: AeronautColors.bgSurface,
          borderRadius: BorderRadius.vertical(top: Radius.circular(AeronautTheme.radiusLg)),
        ),
        child: SafeArea(
          top: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(widget.title, style: AeronautTheme.footnote.copyWith(color: AeronautColors.textSecondary)),
              const SizedBox(height: AeronautTheme.spacingSm),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      key: const ValueKey('tether-capture-field'),
                      controller: _controller,
                      focusNode: _focus,
                      autofocus: true,
                      minLines: 2,
                      maxLines: 6,
                      style: writingStyle(size: 17),
                      decoration: const InputDecoration(hintText: 'A thought for this…'),
                      onChanged: (t) {
                        if (t.trim().isEmpty) _voice = false;
                      },
                    ),
                  ),
                  VoiceButton(
                    fieldKey: _field,
                    purpose: VoicePurpose.capture,
                    controller: _controller,
                    focusNode: _focus,
                    onTranscript: () => _voice = true,
                  ),
                ],
              ),
              const VoiceStatusLine(fieldKey: _field),
              const SizedBox(height: AeronautTheme.spacingMd),
              WorkButton(
                key: const ValueKey('tether-capture-send'),
                label: 'Capture',
                kind: BtnKind.next,
                height: 48,
                busy: _busy,
                onPressed: _submit,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
