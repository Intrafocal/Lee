import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/send_to_lee.dart';
import '../models/voice.dart';
import '../providers/machines_provider.dart';
import '../providers/speech_provider.dart';
import '../providers/tether_provider.dart';
import '../providers/voice_provider.dart';
import '../providers/windows_provider.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/pending_icons.dart';
import '../theme/phosphor_icons.generated.dart';
import '../theme/phosphor_tokens.dart';
import 'phosphor_icon.dart';
import 'voice_button.dart';
import 'work_ui.dart';

/// The composer behind Send to Lee and a tab's Compose mode
/// (docs/plans/2026-09-28-tether-review-voice.md §4.5, §4.6): a native
/// multi-line field (autocorrect, iOS dictation, paste), the mic, attach
/// (photo, screenshot, scribble), and two actions: **Deliver** (into the
/// target's input, not submitted) and **Send** (submitted: Enter in a tab,
/// asked in Hester). A Page has only Deliver. Voice fills the field and
/// never sends; Send only ever comes from its own tap.
class Composer extends ConsumerStatefulWidget {
  /// Where it goes; null means Lee's focus (`'focus'` on the wire).
  final SendTarget? target;

  /// Names the mic's field (one recording at a time).
  final String fieldKey;

  /// Called after a send lands, with a line to show ("Sent to Taxonomy").
  final void Function(SendResult result, String message)? onSent;

  /// A tab's compose bar: tighter, no "Voice note" hint.
  final bool compact;
  final bool autofocus;

  const Composer({
    required this.target,
    required this.fieldKey,
    this.onSent,
    this.compact = false,
    this.autofocus = false,
    super.key,
  });

  @override
  ConsumerState<Composer> createState() => ComposerState();
}

class ComposerState extends ConsumerState<Composer> {
  final _controller = TextEditingController();
  final _focus = FocusNode();
  final List<ImageItem> _images = [];

  /// The text holds a transcript: tag it `input: 'voice'`.
  bool _voice = false;

  /// 'deliver' or 'send' while one is in flight.
  String? _busy;
  String? _error;

  @override
  void initState() {
    super.initState();
    _controller.addListener(() {
      if (_controller.text.trim().isEmpty && _voice) _voice = false;
      if (_error != null) setState(() => _error = null);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// Puts the caret in the field (the sheet's Text choice).
  void focusField() => _focus.requestFocus();

  /// Starts a voice note into the field (the sheet's Voice note choice);
  /// the transcript lands in the field to review, never sent.
  Future<void> startVoice() async {
    final started = await ref.read(voiceProvider.notifier).start(
          widget.fieldKey,
          purpose: VoicePurpose.send,
          workspace: ref.read(windowsProvider).activeWindow?.workspace,
          onTranscript: (text) {
            if (!mounted) return;
            final next = appendTranscript(_controller.text, text);
            _controller.value = TextEditingValue(text: next.text, selection: TextSelection.collapsed(offset: next.caret));
            _focus.requestFocus();
            setState(() => _voice = true);
          },
        );
    if (!started && mounted) setState(() {});
  }

  /// Attaches a photo, screenshot or scribble (the sheet's choices).
  Future<void> attach(ImageSourceKind kind) => _attach(kind);

  List<SendItem> get _items => [
        if (_controller.text.trim().isNotEmpty) TextItem(_controller.text.trim(), voice: _voice),
        ..._images,
      ];

  Future<void> _attach(ImageSourceKind kind) async {
    if (_items.length >= sendMaxItems) {
      setState(() => _error = 'Up to $sendMaxItems things in one send.');
      return;
    }
    final image = await ref.read(imagePickProvider)(context, kind);
    if (image == null || !mounted) return;
    setState(() => _images.add(image));
  }

  Future<void> _showAttach() async {
    final kind = await showModalBottomSheet<ImageSourceKind>(
      context: context,
      backgroundColor: Phosphor.ground3,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              key: const ValueKey('attach-photo'),
              leading: const PhosphorIcon(PendingIcons.camera, size: 20, color: Phosphor.text2),
              title: const Text('Photo'),
              onTap: () => Navigator.pop(ctx, ImageSourceKind.photo),
            ),
            ListTile(
              key: const ValueKey('attach-screenshot'),
              leading: const PhosphorIcon(PhosphorIcons.image, size: 20, color: Phosphor.text2),
              title: const Text('Screenshot'),
              subtitle: const Text('From your photos'),
              onTap: () => Navigator.pop(ctx, ImageSourceKind.screenshot),
            ),
            ListTile(
              key: const ValueKey('attach-scribble'),
              leading: const PhosphorIcon(PhosphorIcons.draw, size: 20, color: Phosphor.text2),
              title: const Text('Scribble'),
              onTap: () => Navigator.pop(ctx, ImageSourceKind.scribble),
            ),
          ],
        ),
      ),
    );
    if (kind != null) await _attach(kind);
  }

  Future<void> _go({required bool submit}) async {
    if (_busy != null) return;
    final items = _items;
    final problem = sendProblem(items, submit: submit, target: widget.target);
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    final machine = ref.read(machinesProvider).activeMachine;
    if (machine == null) return;
    final workspace = ref.read(windowsProvider).activeWindow?.workspace;
    setState(() {
      _busy = submit ? 'send' : 'deliver';
      _error = null;
    });
    final api = ref.read(tetherApiFactoryProvider)(machine);
    final SendResult result;
    try {
      result = await api.send(SendRequest(workspace: workspace, target: widget.target, items: items, submit: submit));
    } finally {
      api.dispose();
    }
    if (!mounted) return;
    if (!result.ok) {
      // Keep the words and the images, so nothing is lost.
      setState(() {
        _busy = null;
        _error = result.error;
      });
      return;
    }
    final usedVoice = _voice;
    final where = (result.deliveredTo ?? widget.target)?.name ?? 'Lee';
    final message = submit ? 'Sent to $where' : 'Delivered to $where';
    setState(() {
      _busy = null;
      _images.clear();
      _voice = false;
    });
    _controller.clear();
    if (usedVoice) {
      final speech = ref.read(speechProvider.notifier);
      speech.autoEnableFromVoice();
      final to = result.deliveredTo ?? widget.target;
      if (submit && to?.kind == SendTargetKind.tab) speech.noteVoiceReply(to!.ptyId);
    }
    widget.onSent?.call(result, message);
  }

  @override
  Widget build(BuildContext context) {
    final target = widget.target;
    final canSubmit = target == null || target.canSubmit;
    final hasText = _controller.text.trim().isNotEmpty;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_images.isNotEmpty) ...[
          SizedBox(
            height: 64,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: _images.length,
              separatorBuilder: (_, _) => const SizedBox(width: AeronautTheme.spacingSm),
              itemBuilder: (_, i) => _Thumb(
                key: ValueKey('attached-$i'),
                image: _images[i],
                onRemove: () => setState(() => _images.removeAt(i)),
              ),
            ),
          ),
          const SizedBox(height: AeronautTheme.spacingSm),
        ],
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            IconButton(
              key: ValueKey('attach-${widget.fieldKey}'),
              tooltip: 'Attach',
              icon: const PhosphorIcon(PhosphorIcons.plus, size: 20, color: Phosphor.text2),
              onPressed: _busy != null ? null : _showAttach,
            ),
            Expanded(
              child: TextField(
                key: ValueKey('compose-${widget.fieldKey}'),
                controller: _controller,
                focusNode: _focus,
                autofocus: widget.autofocus,
                minLines: 1,
                maxLines: widget.compact ? 5 : 8,
                keyboardType: TextInputType.multiline,
                textCapitalization: TextCapitalization.sentences,
                // Your words: the writing font.
                style: writingStyle(size: 16),
                decoration: InputDecoration(
                  hintText: widget.compact ? 'Write to this tab…' : 'Write, or talk…',
                  isDense: true,
                ),
                onChanged: (_) => setState(() {}),
              ),
            ),
            VoiceButton(
              fieldKey: widget.fieldKey,
              purpose: VoicePurpose.send,
              controller: _controller,
              focusNode: _focus,
              workspace: ref.watch(windowsProvider.select((s) => s.activeWindow?.workspace)),
              onTranscript: () => setState(() => _voice = true),
            ),
          ],
        ),
        VoiceStatusLine(fieldKey: widget.fieldKey),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(_error!, key: ValueKey('compose-error-${widget.fieldKey}'), style: AeronautTheme.caption1.copyWith(color: Phosphor.text2)),
          ),
        const SizedBox(height: AeronautTheme.spacingSm),
        Row(
          children: [
            Expanded(
              child: WorkButton(
                key: ValueKey('deliver-${widget.fieldKey}'),
                label: 'Deliver',
                // A Page takes Deliver only: then it's the one next step.
                kind: canSubmit ? BtnKind.plain : BtnKind.next,
                height: widget.compact ? 40 : 48,
                busy: _busy == 'deliver',
                onPressed: _busy == null && (hasText || _images.isNotEmpty) ? () => _go(submit: false) : null,
              ),
            ),
            if (canSubmit) ...[
              const SizedBox(width: AeronautTheme.spacingSm),
              Expanded(
                child: WorkButton(
                  key: ValueKey('send-${widget.fieldKey}'),
                  label: 'Send',
                  kind: BtnKind.next,
                  height: widget.compact ? 40 : 48,
                  busy: _busy == 'send',
                  onPressed: _busy == null && hasText ? () => _go(submit: true) : null,
                ),
              ),
            ],
          ],
        ),
      ],
    );
  }
}

class _Thumb extends StatelessWidget {
  final ImageItem image;
  final VoidCallback onRemove;

  const _Thumb({required this.image, required this.onRemove, super.key});

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(Phosphor.radiusControl),
          child: Image.memory(
            image.bytes,
            width: 64,
            height: 64,
            fit: BoxFit.cover,
            gaplessPlayback: true,
            errorBuilder: (_, _, _) => Container(width: 64, height: 64, color: Phosphor.ground4),
          ),
        ),
        Positioned(
          top: -6,
          right: -6,
          child: GestureDetector(
            onTap: onRemove,
            child: Container(
              padding: const EdgeInsets.all(3),
              decoration: const BoxDecoration(color: Phosphor.ground5, shape: BoxShape.circle),
              child: const PhosphorIcon(PhosphorIcons.close, size: 12, color: Phosphor.text1),
            ),
          ),
        ),
      ],
    );
  }
}
