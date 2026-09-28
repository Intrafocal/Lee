import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/carry.dart';
import '../models/machine.dart';
import '../providers/machines_provider.dart';
import '../providers/windows_provider.dart';
import '../services/copilot_api.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_tokens.dart';
import '../widgets/machine_switcher.dart';
import '../widgets/work_ui.dart';
import 'someday_screen.dart';

typedef CopilotApiBuilder = CopilotApi Function(Machine machine);

/// Library (cockpit design §8.1; Desk D2 §9.4): Tether first, then Ideas.
/// Tether (Carry in the code and routes) is the Cockpit reaching the phone
/// while you're away from the Mac (14 §8.1): your last Desk card, where you
/// stopped in it, what's still open, a thought captured into it, and what
/// the Mac opens next. Devices have no Desk; they stay tethered.
/// (The Explorations tab went with the Desk: explorations were copied into
/// cards, so that list would go stale.)
class LibraryScreen extends ConsumerWidget {
  /// Test seam; defaults to the real client.
  final CopilotApiBuilder? copilotApi;

  const LibraryScreen({this.copilotApi, super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final workspace = ref.watch(windowsProvider.select((s) => s.activeWindow?.workspace));
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const MachineSwitcher(),
          // Tabs are never phosphor (§0 rule 1): the selected one is primary text.
          bottom: const TabBar(
            indicatorColor: Phosphor.text1,
            labelColor: Phosphor.text1,
            unselectedLabelColor: Phosphor.text3,
            dividerColor: Phosphor.ground4,
            tabs: [Tab(text: 'Tether'), Tab(text: 'Ideas')],
          ),
        ),
        body: TabBarView(
          children: [
            CarryView(workspace: workspace, apiBuilder: copilotApi),
            SomedayList(workspace: workspace),
          ],
        ),
      ),
    );
  }
}

/// "2h ago", "3d ago".
String _ago(DateTime? at) {
  if (at == null) return '';
  final d = DateTime.now().toUtc().difference(at.toUtc());
  if (d.inMinutes < 1) return 'just now';
  if (d.inHours < 1) return '${d.inMinutes}m ago';
  if (d.inDays < 1) return '${d.inHours}h ago';
  return '${d.inDays}d ago';
}

/// "3 things to read" / "One thing to read".
String thingsToRead(int n) => n == 1 ? 'One thing to read' : '$n things to read';

CopilotApi _copilot(WidgetRef ref, CopilotApiBuilder? builder) {
  final machine = ref.read(machinesProvider).activeMachine!;
  return (builder ?? (m) => CopilotApi(machine: m))(machine);
}

/// Captures [text] into the card [cardId] (or on its own), then says so.
Future<bool> _capture(
  BuildContext context,
  WidgetRef ref,
  CopilotApiBuilder? builder, {
  required String? workspace,
  required String? cardId,
  required String text,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  final api = _copilot(ref, builder);
  try {
    final result = await api.carryCapture(text, workspace: workspace, cardId: cardId);
    messenger.showSnackBar(SnackBar(
      content: Text(result.success
          ? (result.spooled ? 'Saved; will sync when Hester is back' : 'Captured')
          : (result.error ?? 'Capture failed')),
    ));
    return result.success;
  } finally {
    api.dispose();
  }
}

/// Asks the Mac to open the card [cardId] first in its next Deep session.
Future<bool> _openNext(
  BuildContext context,
  WidgetRef ref,
  CopilotApiBuilder? builder, {
  required String? workspace,
  required String cardId,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  final api = _copilot(ref, builder);
  try {
    final result = await api.carryOpenNext(workspace: workspace, cardId: cardId);
    messenger.showSnackBar(SnackBar(
      content: Text(result.success ? 'The Mac opens this first next time' : (result.error ?? 'Could not set that')),
    ));
    return result.success;
  } finally {
    api.dispose();
  }
}

/// A bottom sheet with one Newsreader field ("Capture a thought into this").
Future<void> showCarryCaptureSheet(
  BuildContext context, {
  required String title,
  required Future<bool> Function(String text) onCapture,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _CarryCaptureSheet(title: title, onCapture: onCapture),
  );
}

class _CarryCaptureSheet extends StatefulWidget {
  final String title;
  final Future<bool> Function(String text) onCapture;

  const _CarryCaptureSheet({required this.title, required this.onCapture});

  @override
  State<_CarryCaptureSheet> createState() => _CarryCaptureSheetState();
}

class _CarryCaptureSheetState extends State<_CarryCaptureSheet> {
  final _controller = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final text = _controller.text.trim();
    if (text.isEmpty || _busy) return;
    setState(() => _busy = true);
    final navigator = Navigator.of(context);
    final ok = await widget.onCapture(text);
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
              TextField(
                key: const ValueKey('carry-capture-field'),
                controller: _controller,
                autofocus: true,
                minLines: 2,
                maxLines: 6,
                style: writingStyle(size: 17),
                decoration: const InputDecoration(hintText: 'A thought for this…'),
              ),
              const SizedBox(height: AeronautTheme.spacingMd),
              WorkButton(
                key: const ValueKey('carry-capture-send'),
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

/// Tether (14 §8.1, Desk D2 §9.4): your last Desk card's title and Area,
/// "You stopped at" in Newsreader italic, the open questions in
/// Newsreader, "Capture a thought into this" (the view's one phosphor
/// step), "Open this first on the Mac", and the reading count.
class CarryView extends ConsumerStatefulWidget {
  final String? workspace;
  final CopilotApiBuilder? apiBuilder;

  const CarryView({required this.workspace, this.apiBuilder, super.key});

  @override
  ConsumerState<CarryView> createState() => _CarryViewState();
}

class _CarryViewState extends ConsumerState<CarryView> {
  CarryResult? _result;
  bool _loading = true;
  bool _settingNext = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant CarryView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.workspace != widget.workspace) _load();
  }

  Future<void> _load() async {
    if (ref.read(machinesProvider).activeMachine == null) return;
    setState(() => _loading = true);
    final api = _copilot(ref, widget.apiBuilder);
    try {
      final result = await api.getCarry(workspace: widget.workspace);
      if (!mounted) return;
      setState(() {
        _result = result;
        _loading = false;
      });
    } finally {
      api.dispose();
    }
  }

  @override
  Widget build(BuildContext context) {
    final result = _result;
    if (_loading && result == null) {
      return const Center(child: CircularProgressIndicator.adaptive());
    }
    final carry = result?.carry;
    return RefreshIndicator.adaptive(
      color: AeronautColors.accent,
      backgroundColor: AeronautColors.bgSurface,
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(AeronautTheme.spacingMd),
        children: carry == null ? _error(result) : _body(carry),
      ),
    );
  }

  List<Widget> _error(CarryResult? result) {
    return [
      const SizedBox(height: AeronautTheme.spacingXl),
      Text(
        result?.hesterOffline ?? false ? 'Hester is offline.' : 'Tether could not load.',
        style: writingStyle(size: 20),
      ),
      const SizedBox(height: AeronautTheme.spacingSm),
      QuietText(result?.hesterOffline ?? false
          ? 'Tether comes from Hester on the Mac. Pull to try again once Lee is running.'
          : (result?.error ?? 'Pull to try again.')),
    ];
  }

  List<Widget> _body(CarrySnapshot carry) {
    final pickUp = carry.pickUp;
    final opensFirst = pickUp != null && carry.opensFirst(pickUp.cardId);
    final touched = pickUp?.lastTouchedAt == null ? null : _ago(pickUp!.lastTouchedAt);
    final where = pickUp?.areaName != null
        ? [pickUp!.areaName!, if (touched != null) 'last touched $touched'].join(' · ')
        : (touched != null ? 'Last touched $touched' : '');
    return [
      if (pickUp != null) ...[
        // The card's title is your words: Newsreader.
        Text(
          pickUp.title.isEmpty ? 'Untitled page' : pickUp.title,
          key: const ValueKey('carry-card-title'),
          style: writingStyle(size: 22),
        ),
        if (where.isNotEmpty) ...[
          const SizedBox(height: 2),
          QuietText(where),
        ],
        const _Label('You stopped at'),
        if (pickUp.stoppedAt != null)
          WritingQuote(pickUp.stoppedAt!, size: 19)
        else
          const QuietText('No note from the last session.'),
      ] else ...[
        const SizedBox(height: AeronautTheme.spacingLg),
        Text('Nothing to pick up yet.', style: writingStyle(size: 20)),
        const SizedBox(height: AeronautTheme.spacingSm),
        const QuietText('When you end a session at your Desk on the Mac, where you stopped shows here.'),
      ],
      if (carry.openQuestions.isNotEmpty) ...[
        const _Label('Open questions'),
        for (final q in carry.openQuestions)
          Padding(
            padding: const EdgeInsets.only(bottom: AeronautTheme.spacingSm),
            child: Text(q.text, style: writingStyle(size: 17)),
          ),
      ],
      const SizedBox(height: AeronautTheme.spacingLg),
      WorkButton(
        key: const ValueKey('carry-capture'),
        label: pickUp != null ? 'Capture a thought into this' : 'Capture a thought',
        kind: BtnKind.next,
        height: 48,
        onPressed: () => showCarryCaptureSheet(
          context,
          title: pickUp != null ? 'Into ${pickUp.title.isEmpty ? 'this page' : pickUp.title}' : 'Captured away',
          onCapture: (text) async {
            final ok = await _capture(
              context,
              ref,
              widget.apiBuilder,
              workspace: widget.workspace,
              cardId: pickUp?.cardId,
              text: text,
            );
            if (ok) await _load();
            return ok;
          },
        ),
      ),
      if (pickUp != null) ...[
        const SizedBox(height: AeronautTheme.spacingSm),
        WorkButton(
          key: const ValueKey('carry-open-next'),
          label: opensFirst ? 'Opens first on the Mac' : 'Open this first on the Mac',
          height: 48,
          busy: _settingNext,
          onPressed: opensFirst
              ? null
              : () async {
                  setState(() => _settingNext = true);
                  final ok = await _openNext(
                    context,
                    ref,
                    widget.apiBuilder,
                    workspace: widget.workspace,
                    cardId: pickUp.cardId,
                  );
                  if (!mounted) return;
                  setState(() => _settingNext = false);
                  if (ok) await _load();
                },
        ),
      ],
      const SizedBox(height: AeronautTheme.spacingLg),
      if (carry.readingCount > 0) QuietText(thingsToRead(carry.readingCount)),
      if (carry.capturedCount > 0) ...[
        const SizedBox(height: 4),
        QuietText('${carry.capturedCount} captured away'),
      ],
      if (carry.spooled > 0) ...[
        const SizedBox(height: 4),
        QuietText('${carry.spooled} waiting for Hester'),
      ],
    ];
  }
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
