import 'dart:convert';
import 'dart:typed_data';

import 'package:equatable/equatable.dart';

/// Send to Lee (docs/plans/2026-09-28-tether-review-voice.md §4): the phone
/// as an input for Lee. Mirrors `SendTarget`, `SendItem`, `SendRequest`,
/// `SendTargets` and `SendResult` in `electron/src/shared/tether.ts` by hand.
///
/// Two modes, chosen by the button you tap: Deliver (into the target's
/// input, not submitted) and Send (`submit: true`). A Page has only
/// Deliver; voice never submits.

enum SendTargetKind { page, hester, tab, board }

/// Where a send lands: a Page, Hester's palette, or a PTY tab. (`board` is
/// reserved on the wire and not built this round.)
class SendTarget extends Equatable {
  final SendTargetKind kind;

  /// Page and Board targets.
  final String? cardId;
  final String? title;

  /// Tab targets.
  final int? ptyId;
  final String? label;

  /// 'agent', 'terminal' or 'tui'.
  final String? tabKind;
  final String? provider;

  const SendTarget._board({required String this.cardId, required String this.title})
      : kind = SendTargetKind.board,
        ptyId = null,
        label = null,
        tabKind = null,
        provider = null;

  const SendTarget.page({required String this.cardId, required String this.title})
      : kind = SendTargetKind.page,
        ptyId = null,
        label = null,
        tabKind = null,
        provider = null;

  const SendTarget.hester()
      : kind = SendTargetKind.hester,
        cardId = null,
        title = null,
        ptyId = null,
        label = null,
        tabKind = null,
        provider = null;

  const SendTarget.tab({required int this.ptyId, required String this.label, required String this.tabKind, this.provider})
      : kind = SendTargetKind.tab,
        cardId = null,
        title = null;

  /// Null for an unknown kind, so a newer Lee's target is skipped, not misread.
  static SendTarget? fromJson(Map<String, dynamic> json) {
    switch (json['kind']) {
      case 'page':
        final id = json['card_id'];
        if (id is! String || id.isEmpty) return null;
        return SendTarget.page(cardId: id, title: json['title'] as String? ?? '');
      case 'hester':
        return const SendTarget.hester();
      case 'tab':
        final pty = json['pty_id'];
        if (pty is! num) return null;
        return SendTarget.tab(
          ptyId: pty.toInt(),
          label: json['label'] as String? ?? '',
          tabKind: json['tab_kind'] as String? ?? 'terminal',
          provider: json['provider'] as String?,
        );
      case 'board':
        final id = json['card_id'];
        if (id is! String || id.isEmpty) return null;
        return SendTarget._board(cardId: id, title: json['title'] as String? ?? '');
    }
    return null;
  }

  Map<String, dynamic> toJson() => switch (kind) {
        SendTargetKind.page || SendTargetKind.board => {'kind': kind.name, 'card_id': cardId, 'title': title ?? ''},
        SendTargetKind.hester => const {'kind': 'hester'},
        SendTargetKind.tab => {
            'kind': 'tab',
            'pty_id': ptyId,
            'label': label ?? '',
            'tab_kind': tabKind ?? 'terminal',
            'provider': provider,
          },
      };

  /// Send (submitted) exists for tabs and Hester; a Page takes Deliver only.
  bool get canSubmit => kind == SendTargetKind.tab || kind == SendTargetKind.hester;

  /// "Taxonomy", "Hester", "Claude 2".
  String get name => switch (kind) {
        SendTargetKind.page || SendTargetKind.board => (title ?? '').trim().isEmpty ? 'Untitled page' : title!,
        SendTargetKind.hester => 'Hester',
        SendTargetKind.tab => (label ?? '').trim().isEmpty ? 'Tab $ptyId' : label!,
      };

  /// What it is, for the picker's second line and "To: X (…)".
  String get what => switch (kind) {
        SendTargetKind.page => 'Page',
        SendTargetKind.board => 'Board',
        SendTargetKind.hester => 'the palette',
        SendTargetKind.tab => switch (tabKind) {
            'agent' => provider == null ? 'agent' : '$provider agent',
            'tui' => 'TUI',
            _ => 'terminal',
          },
      };

  /// Same place on the wire (titles and labels may change under it).
  bool sameAs(SendTarget other) =>
      kind == other.kind && cardId == other.cardId && ptyId == other.ptyId;

  @override
  List<Object?> get props => [kind, cardId, title, ptyId, label, tabKind, provider];
}

/// "the Page you're on" / "the palette that's open" / "the tab you're on":
/// how Lee's focus reads in "To: Taxonomy (the Page you're on)".
String focusPhrase(SendTarget t) => switch (t.kind) {
      SendTargetKind.page || SendTargetKind.board => "the Page you're on",
      SendTargetKind.hester => "the palette that's open",
      SendTargetKind.tab => "the tab you're on",
    };

/// `GET /tether/targets`.
class SendTargets extends Equatable {
  final SendTarget? focus;
  final List<SendTarget> targets;

  const SendTargets({this.focus, this.targets = const []});

  factory SendTargets.fromJson(Map<String, dynamic> json) {
    final focus = json['focus'] is Map<String, dynamic> ? SendTarget.fromJson(json['focus'] as Map<String, dynamic>) : null;
    final targets = (json['targets'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(SendTarget.fromJson)
        .whereType<SendTarget>()
        // Board is reserved and not built: never offered.
        .where((t) => t.kind != SendTargetKind.board)
        .toList();
    return SendTargets(focus: focus?.kind == SendTargetKind.board ? null : focus, targets: targets);
  }

  /// Focus first, then the rest without repeating it.
  List<SendTarget> get all => [
        if (focus != null) focus!,
        for (final t in targets)
          if (focus == null || !t.sameAs(focus!)) t,
      ];

  @override
  List<Object?> get props => [focus, targets];
}

enum ImageSourceKind { photo, screenshot, scribble }

/// One piece of a send: text (a voice note arrives as its reviewed
/// transcript, tagged [voice]) or an image.
sealed class SendItem extends Equatable {
  const SendItem();

  Map<String, dynamic> toJson();
}

class TextItem extends SendItem {
  final String text;
  final bool voice;

  const TextItem(this.text, {this.voice = false});

  @override
  Map<String, dynamic> toJson() => {'kind': 'text', 'text': text, if (voice) 'input': 'voice'};

  @override
  List<Object?> get props => [text, voice];
}

class ImageItem extends SendItem {
  /// 'image/png' or 'image/jpeg'.
  final String mime;
  final Uint8List bytes;
  final ImageSourceKind source;
  final String? caption;

  const ImageItem({required this.mime, required this.bytes, required this.source, this.caption});

  @override
  Map<String, dynamic> toJson() => {
        'kind': 'image',
        'mime': mime,
        'data_b64': base64Encode(bytes),
        if (caption != null && caption!.trim().isNotEmpty) 'caption': caption!.trim(),
        'source': source.name,
      };

  @override
  List<Object?> get props => [mime, bytes.length, source, caption];
}

/// Limits `POST /tether/send` enforces (§4.2); checked here first so the
/// sheet can say why before it uploads anything.
const sendMaxItems = 4;
const sendMaxImageBytes = 10 * 1024 * 1024;
const sendMaxTextChars = 20000;

/// Why [items] can't go as one send, or null when they can.
String? sendProblem(List<SendItem> items, {required bool submit, required SendTarget? target}) {
  if (items.isEmpty) return 'Nothing to send yet.';
  if (items.length > sendMaxItems) return 'Up to $sendMaxItems things in one send.';
  for (final item in items) {
    if (item is TextItem && item.text.length > sendMaxTextChars) return 'That text is too long to send.';
    if (item is ImageItem && item.bytes.length > sendMaxImageBytes) return 'That image is over 10 MB.';
  }
  if (submit) {
    if (target != null && !target.canSubmit) return 'A Page takes Deliver only.';
    if (!items.any((i) => i is TextItem)) return 'Send needs some text; Deliver the image instead.';
  }
  return null;
}

/// `POST /tether/send`. [target] null means `'focus'`.
class SendRequest extends Equatable {
  final String? workspace;
  final SendTarget? target;
  final List<SendItem> items;
  final bool submit;

  /// From a tab's own compose bar: Lee shows no chip, since you're watching that tab.
  final bool compose;

  const SendRequest({this.workspace, this.target, required this.items, this.submit = false, this.compose = false});

  Map<String, dynamic> toJson() => {
        if (workspace != null) 'workspace': workspace,
        'target': target?.toJson() ?? 'focus',
        'items': [for (final i in items) i.toJson()],
        if (submit) 'submit': true,
        if (compose) 'compose': true,
      };

  @override
  List<Object?> get props => [workspace, target, items, submit, compose];
}

/// The outcome of a send: where it went, or why it didn't.
class SendResult extends Equatable {
  final String? sendId;
  final SendTarget? deliveredTo;
  final String? error;

  const SendResult({this.sendId, this.deliveredTo, this.error});

  bool get ok => error == null;

  factory SendResult.fromJson(Map<String, dynamic> json) => SendResult(
        sendId: json['send_id'] as String?,
        deliveredTo:
            json['delivered_to'] is Map<String, dynamic> ? SendTarget.fromJson(json['delivered_to'] as Map<String, dynamic>) : null,
      );

  @override
  List<Object?> get props => [sendId, deliveredTo, error];
}
