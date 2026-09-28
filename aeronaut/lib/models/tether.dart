import 'package:equatable/equatable.dart';

/// Tether: the Cockpit on the phone (docs/14-Deep-Work.md §8.1). Mirrors
/// Lee main's `/tether/*` routes, `electron/src/shared/tether.ts`
/// (docs/plans/2026-09-28-tether-review-voice.md §3.3), by hand:
/// [Tether] feeds Work's Pick up block; [TetherDesk], [TetherPage] and
/// [TetherDrawer] feed Review. Devices read the Desk; they never edit it.

/// The card to pick up: your last Desk card.
class TetherPickUp extends Equatable {
  final String cardId;
  final String cardKind;
  final String title;

  /// The Area the card sits in, when Lee knows it.
  final String? areaName;

  /// Your last sentence from the session's ending ritual; null when none was written.
  final String? stoppedAt;

  /// 1-based line in the card's page where [stoppedAt] is.
  final int? stoppedLine;
  final DateTime? lastTouchedAt;

  const TetherPickUp({
    required this.cardId,
    this.cardKind = 'page',
    this.title = '',
    this.areaName,
    this.stoppedAt,
    this.stoppedLine,
    this.lastTouchedAt,
  });

  factory TetherPickUp.fromJson(Map<String, dynamic> json) {
    return TetherPickUp(
      cardId: json['card_id'] as String? ?? '',
      cardKind: json['card_kind'] as String? ?? 'page',
      title: json['title'] as String? ?? '',
      areaName: _nonEmpty(json['area_name']),
      stoppedAt: _nonEmpty(json['stopped_at']),
      stoppedLine: (json['stopped_line'] as num?)?.toInt(),
      lastTouchedAt: _parseDate(json['last_touched_at']),
    );
  }

  @override
  List<Object?> get props => [cardId, cardKind, title, areaName, stoppedAt, stoppedLine, lastTouchedAt];
}

/// One open question, in your words.
class TetherQuestion extends Equatable {
  final String cardId;
  final String questionId;
  final String text;

  const TetherQuestion({required this.cardId, required this.questionId, required this.text});

  factory TetherQuestion.fromJson(Map<String, dynamic> json) {
    return TetherQuestion(
      cardId: json['card_id'] as String? ?? '',
      questionId: json['question_id'] as String? ?? '',
      text: json['text'] as String? ?? '',
    );
  }

  @override
  List<Object?> get props => [cardId, questionId, text];
}

/// `GET /tether`: where you stopped and what's still open.
class Tether extends Equatable {
  final String? workspace;
  final TetherPickUp? pickUp;

  /// At most 5.
  final List<TetherQuestion> openQuestions;

  /// Ideas captured away since the last Desk session.
  final int capturedCount;

  /// Captures waiting in Lee's spool for Hester.
  final int spooled;

  const Tether({
    this.workspace,
    this.pickUp,
    this.openQuestions = const [],
    this.capturedCount = 0,
    this.spooled = 0,
  });

  factory Tether.fromJson(Map<String, dynamic> json) {
    return Tether(
      workspace: json['workspace'] as String?,
      pickUp: json['pick_up'] is Map<String, dynamic>
          ? TetherPickUp.fromJson(json['pick_up'] as Map<String, dynamic>)
          : null,
      openQuestions: _list(json['open_questions'], TetherQuestion.fromJson).where((q) => q.text.isNotEmpty).take(5).toList(),
      capturedCount: (json['captured_count'] as num?)?.toInt() ?? 0,
      spooled: (json['spooled'] as num?)?.toInt() ?? 0,
    );
  }

  @override
  List<Object?> get props => [workspace, pickUp, openQuestions, capturedCount, spooled];
}

/// Result of a Tether read: the snapshot, or why there isn't one.
class TetherResult extends Equatable {
  final Tether? tether;

  /// 'hester_offline', 'unauthorized', or another message.
  final String? error;

  const TetherResult({this.tether, this.error});

  bool get hesterOffline => error == 'hester_offline';

  @override
  List<Object?> get props => [tether, error];
}

/// Any other `/tether/*` read: the value, or why there isn't one
/// ('hester_offline' or a message).
class TetherRead<T> extends Equatable {
  final T? value;
  final String? error;

  const TetherRead.ok(T this.value) : error = null;
  const TetherRead.failed(String this.error) : value = null;

  bool get hesterOffline => error == 'hester_offline';

  @override
  List<Object?> get props => [value, error];
}

/// A Desk card as devices see it: counts, no text.
class TetherCard extends Equatable {
  final String id;
  final String kind;
  final String title;
  final String? areaId;
  final String? areaName;
  final bool stashed;
  final DateTime? updatedAt;
  final int chars;
  final int answers;
  final int openQuestions;

  const TetherCard({
    required this.id,
    this.kind = 'page',
    this.title = '',
    this.areaId,
    this.areaName,
    this.stashed = false,
    this.updatedAt,
    this.chars = 0,
    this.answers = 0,
    this.openQuestions = 0,
  });

  factory TetherCard.fromJson(Map<String, dynamic> json) {
    return TetherCard(
      id: json['id'] as String? ?? '',
      kind: json['kind'] as String? ?? 'page',
      title: json['title'] as String? ?? '',
      areaId: _nonEmpty(json['area_id']),
      areaName: _nonEmpty(json['area_name']),
      stashed: json['stashed'] as bool? ?? false,
      updatedAt: _parseDate(json['updated_at']),
      chars: (json['chars'] as num?)?.toInt() ?? 0,
      answers: (json['answers'] as num?)?.toInt() ?? 0,
      openQuestions: (json['open_questions'] as num?)?.toInt() ?? 0,
    );
  }

  String get displayTitle => title.trim().isEmpty ? 'Untitled page' : title;

  @override
  List<Object?> get props => [id, kind, title, areaId, areaName, stashed, updatedAt, chars, answers, openQuestions];
}

/// An Area with its Pages: on the Desk, or stashed in the Drawer
/// ([stashedAt] set).
class TetherArea extends Equatable {
  final String id;
  final String name;
  final List<TetherCard> cards;
  final DateTime? stashedAt;

  const TetherArea({required this.id, required this.name, this.cards = const [], this.stashedAt});

  factory TetherArea.fromJson(Map<String, dynamic> json) {
    return TetherArea(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      cards: _list(json['cards'], TetherCard.fromJson),
      stashedAt: _parseDate(json['stashed_at']),
    );
  }

  @override
  List<Object?> get props => [id, name, cards, stashedAt];
}

/// `GET /tether/desk`: the Areas on the Desk (not stashed).
class TetherDesk extends Equatable {
  final String? workspace;
  final List<TetherArea> areas;
  final TetherCard? goalsCard;
  final String? lastCardId;

  const TetherDesk({this.workspace, this.areas = const [], this.goalsCard, this.lastCardId});

  factory TetherDesk.fromJson(Map<String, dynamic> json) {
    return TetherDesk(
      workspace: json['workspace'] as String?,
      areas: _list(json['areas'], TetherArea.fromJson),
      goalsCard: json['goals_card'] is Map<String, dynamic>
          ? TetherCard.fromJson(json['goals_card'] as Map<String, dynamic>)
          : null,
      lastCardId: _nonEmpty(json['last_card_id']),
    );
  }

  @override
  List<Object?> get props => [workspace, areas, goalsCard, lastCardId];
}

class PageAnswer extends Equatable {
  final String id;
  final String question;
  final String? answer;
  final String status;

  const PageAnswer({required this.id, this.question = '', this.answer, this.status = ''});

  factory PageAnswer.fromJson(Map<String, dynamic> json) => PageAnswer(
        id: json['id'] as String? ?? '',
        question: json['question'] as String? ?? '',
        answer: _nonEmpty(json['answer']),
        status: json['status'] as String? ?? '',
      );

  @override
  List<Object?> get props => [id, question, answer, status];
}

class PageHandoff extends Equatable {
  final String id;
  final String kind;
  final String? provider;
  final String status;
  final String? result;

  const PageHandoff({required this.id, this.kind = '', this.provider, this.status = '', this.result});

  factory PageHandoff.fromJson(Map<String, dynamic> json) => PageHandoff(
        id: json['id'] as String? ?? '',
        kind: json['kind'] as String? ?? '',
        provider: _nonEmpty(json['provider']),
        status: json['status'] as String? ?? '',
        result: _nonEmpty(json['result']),
      );

  @override
  List<Object?> get props => [id, kind, provider, status, result];
}

class PageQuestion extends Equatable {
  final String id;
  final String text;

  const PageQuestion({required this.id, required this.text});

  factory PageQuestion.fromJson(Map<String, dynamic> json) =>
      PageQuestion(id: json['id'] as String? ?? '', text: json['text'] as String? ?? '');

  @override
  List<Object?> get props => [id, text];
}

class PageReference extends Equatable {
  final String title;
  final String? where;
  final String? quote;

  const PageReference({this.title = '', this.where, this.quote});

  factory PageReference.fromJson(Map<String, dynamic> json) => PageReference(
        title: json['title'] as String? ?? '',
        where: _nonEmpty(json['where']),
        quote: _nonEmpty(json['quote']),
      );

  @override
  List<Object?> get props => [title, where, quote];
}

/// `GET /tether/pages/:id`: a Page's text (markdown, ≤ 200 KB) and what
/// hangs off it. With `?text_only=1` only [card] and [text] come back.
class TetherPage extends Equatable {
  final TetherCard card;
  final String text;
  final List<PageAnswer> answers;
  final List<PageHandoff> handoffs;
  final List<PageQuestion> openQuestions;
  final List<PageReference> references;

  const TetherPage({
    required this.card,
    this.text = '',
    this.answers = const [],
    this.handoffs = const [],
    this.openQuestions = const [],
    this.references = const [],
  });

  factory TetherPage.fromJson(Map<String, dynamic> json) {
    return TetherPage(
      card: TetherCard.fromJson(json['card'] is Map<String, dynamic> ? json['card'] as Map<String, dynamic> : const {}),
      text: json['text'] as String? ?? '',
      answers: _list(json['answers'], PageAnswer.fromJson),
      handoffs: _list(json['handoffs'], PageHandoff.fromJson),
      openQuestions: _list(json['open_questions'], PageQuestion.fromJson),
      references: _list(json['references'], PageReference.fromJson),
    );
  }

  @override
  List<Object?> get props => [card, text, answers, handoffs, openQuestions, references];
}

/// A thought captured into Ideas (Lee, the phone, the T-Deck).
class TetherIdea extends Equatable {
  final String id;
  final String text;
  final DateTime? createdAt;

  /// 'lee', 'aeronaut', 'dirigible', 'cli', …; null when unknown.
  final String? surface;

  const TetherIdea({required this.id, this.text = '', this.createdAt, this.surface});

  factory TetherIdea.fromJson(Map<String, dynamic> json) => TetherIdea(
        id: json['id'] as String? ?? '',
        text: json['text'] as String? ?? '',
        createdAt: _parseDate(json['created_at']),
        surface: _nonEmpty(json['surface']),
      );

  /// Captured on a device: your words, set in the writing font.
  bool get fromDevice => const {'aeronaut', 'dirigible', 'device'}.contains(surface);

  @override
  List<Object?> get props => [id, text, createdAt, surface];
}

/// `GET /tether/drawer`: Stashed Areas and Ideas.
class TetherDrawer extends Equatable {
  final List<TetherArea> stashed;
  final List<TetherIdea> ideas;

  const TetherDrawer({this.stashed = const [], this.ideas = const []});

  factory TetherDrawer.fromJson(Map<String, dynamic> json) => TetherDrawer(
        stashed: _list(json['stashed'], TetherArea.fromJson),
        ideas: _list(json['ideas'], TetherIdea.fromJson).where((i) => i.text.isNotEmpty).toList(),
      );

  @override
  List<Object?> get props => [stashed, ideas];
}

List<T> _list<T>(dynamic value, T Function(Map<String, dynamic>) fromJson) =>
    value is List ? value.whereType<Map<String, dynamic>>().map(fromJson).toList() : <T>[];

String? _nonEmpty(dynamic value) => value is String && value.trim().isNotEmpty ? value : null;

DateTime? _parseDate(dynamic value) {
  if (value is String && value.isNotEmpty) return DateTime.tryParse(value);
  return null;
}
