import 'package:equatable/equatable.dart';

/// Copilot v0/v1 attention-queue models (contracts §5.1, Appendix A).
///
/// Hand-written mirrors of `electron/src/shared/copilot.ts` — this package
/// has no codegen and no shared build with Electron, so field names are
/// translated from camelCase/snake_case wire values by hand, defensively
/// (missing/unknown values fall back to safe defaults rather than throwing,
/// matching the rest of this app's model style — see `models/fs_entry.dart`).

/// What kind of thing is waiting for a human (contracts §5.1).
enum AttentionKind {
  approval,
  waiting,
  blocker,
  decision,
  failure,
  review,
  summary,
  question;

  static AttentionKind fromWire(String? value) => switch (value) {
        'approval' => AttentionKind.approval,
        'waiting' => AttentionKind.waiting,
        'blocker' => AttentionKind.blocker,
        'decision' => AttentionKind.decision,
        'failure' => AttentionKind.failure,
        'review' => AttentionKind.review,
        'summary' => AttentionKind.summary,
        'question' => AttentionKind.question,
        _ => AttentionKind.waiting,
      };
}

enum AttentionSeverity {
  ambient,
  needsYou,
  blocking;

  static AttentionSeverity fromWire(String? value) => switch (value) {
        'blocking' => AttentionSeverity.blocking,
        'needs-you' => AttentionSeverity.needsYou,
        _ => AttentionSeverity.ambient,
      };
}

enum AttentionItemState {
  open,
  snoozed,
  resolved,
  dismissed;

  static AttentionItemState fromWire(String? value) => switch (value) {
        'open' => AttentionItemState.open,
        'snoozed' => AttentionItemState.snoozed,
        'resolved' => AttentionItemState.resolved,
        'dismissed' => AttentionItemState.dismissed,
        _ => AttentionItemState.open,
      };
}

enum AttentionActionName {
  approve,
  deny,
  reply,
  open,
  snooze,
  dismiss,
  wake,
  choose;

  static AttentionActionName? fromWire(String value) => switch (value) {
        'approve' => AttentionActionName.approve,
        'deny' => AttentionActionName.deny,
        'reply' => AttentionActionName.reply,
        'open' => AttentionActionName.open,
        'snooze' => AttentionActionName.snooze,
        'dismiss' => AttentionActionName.dismiss,
        'wake' => AttentionActionName.wake,
        'choose' => AttentionActionName.choose,
        _ => null,
      };
}

/// One option offered by an `AskUserQuestion` sub-question.
class QuestionOption extends Equatable {
  final String label;
  final String? description;

  const QuestionOption({required this.label, this.description});

  factory QuestionOption.fromJson(Map<String, dynamic> json) {
    return QuestionOption(
      label: json['label'] as String? ?? '',
      description: json['description'] as String?,
    );
  }

  @override
  List<Object?> get props => [label, description];
}

/// One sub-question of an `AskUserQuestion` call.
class Question extends Equatable {
  final String question;
  final String? header;
  final bool multiSelect;
  final List<QuestionOption> options;

  const Question({
    required this.question,
    this.header,
    this.multiSelect = false,
    this.options = const [],
  });

  factory Question.fromJson(Map<String, dynamic> json) {
    return Question(
      question: json['question'] as String? ?? '',
      header: json['header'] as String?,
      multiSelect: json['multi_select'] as bool? ?? false,
      options: (json['options'] as List<dynamic>?)
              ?.whereType<Map<String, dynamic>>()
              .map(QuestionOption.fromJson)
              .toList() ??
          const [],
    );
  }

  @override
  List<Object?> get props => [question, header, multiSelect, options];
}

/// `item.question` on a `question`-kind item (Claude's `AskUserQuestion`
/// tool): one or more sub-questions from a single call. Aeronaut only offers
/// a tap-to-answer UI ([singleAnswerable]) when there is exactly one
/// sub-question, it isn't multi-select, and it has options to tap — the
/// same "exactly one question and multi_select is false" rule the `choose`
/// reply action requires server-side. Anything else falls back to a
/// read-only view with an "Open tab" action (a human decision must stay
/// explicit, never guessed at from a partial UI — C3).
class QuestionSet extends Equatable {
  final List<Question> questions;

  const QuestionSet({this.questions = const []});

  factory QuestionSet.fromJson(Map<String, dynamic> json) {
    return QuestionSet(
      questions: (json['questions'] as List<dynamic>?)
              ?.whereType<Map<String, dynamic>>()
              .map(Question.fromJson)
              .toList() ??
          const [],
    );
  }

  Question? get singleAnswerable {
    if (questions.length != 1) return null;
    final q = questions.single;
    if (q.multiSelect || q.options.isEmpty) return null;
    return q;
  }

  @override
  List<Object?> get props => [questions];
}

class LeeStatusBlock extends Equatable {
  final String? status;
  final String? summary;
  final String? blockers;
  final List<String> files;
  final String? next;

  const LeeStatusBlock({
    this.status,
    this.summary,
    this.blockers,
    this.files = const [],
    this.next,
  });

  factory LeeStatusBlock.fromJson(Map<String, dynamic> json) {
    return LeeStatusBlock(
      status: json['status'] as String?,
      summary: json['summary'] as String?,
      blockers: json['blockers'] as String?,
      files: (json['files'] as List<dynamic>?)
              ?.map((f) => f as String)
              .toList() ??
          const [],
      next: json['next'] as String?,
    );
  }

  @override
  List<Object?> get props => [status, summary, blockers, files, next];
}

class ToolPreview extends Equatable {
  final String name;
  final String preview;
  final String signature;

  const ToolPreview({
    required this.name,
    required this.preview,
    required this.signature,
  });

  factory ToolPreview.fromJson(Map<String, dynamic> json) {
    return ToolPreview(
      name: json['name'] as String? ?? '',
      preview: json['preview'] as String? ?? '',
      signature: json['signature'] as String? ?? '',
    );
  }

  @override
  List<Object?> get props => [name, preview, signature];
}

class AttentionSource extends Equatable {
  final String? kind; // agent | lee
  final String? provider;
  final String? sessionId;
  final int? ptyId;
  final int? windowId;
  final int? tabId;
  final String? tabLabel;
  final String? workspace;
  final String? cwd;

  const AttentionSource({
    this.kind,
    this.provider,
    this.sessionId,
    this.ptyId,
    this.windowId,
    this.tabId,
    this.tabLabel,
    this.workspace,
    this.cwd,
  });

  factory AttentionSource.fromJson(Map<String, dynamic> json) {
    return AttentionSource(
      kind: json['kind'] as String?,
      provider: json['provider'] as String?,
      sessionId: json['session_id'] as String?,
      ptyId: (json['pty_id'] as num?)?.toInt(),
      windowId: (json['window_id'] as num?)?.toInt(),
      tabId: (json['tab_id'] as num?)?.toInt(),
      tabLabel: json['tab_label'] as String?,
      workspace: json['workspace'] as String?,
      cwd: json['cwd'] as String?,
    );
  }

  /// Basename of [workspace], for a compact "tab · workspace" label.
  String? get workspaceName {
    if (workspace == null || workspace!.isEmpty) return null;
    return workspace!.split('/').last;
  }

  @override
  List<Object?> get props => [
        kind,
        provider,
        sessionId,
        ptyId,
        windowId,
        tabId,
        tabLabel,
        workspace,
        cwd,
      ];
}

/// One entry in the attention queue (contracts §5.1, Appendix A). Parses
/// both the full form and the `?compact=1` form (no `files`, `text` capped
/// at 280 chars server-side).
class AttentionItem extends Equatable {
  final String id;
  final int version;
  final AttentionKind kind;
  final AttentionSeverity severity;
  final AttentionItemState state;
  final bool parked;
  final bool wake;
  final bool notify;
  final bool relatedToFocus;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final int activeWaitMs;
  final String title;
  final String text;
  final AttentionSource source;

  /// Files the agent session wrote (max 50). Null in compact form —
  /// distinct from an empty list, which means "none written".
  final List<String>? files;
  final ToolPreview? tool;
  final LeeStatusBlock? leeStatus;
  final List<AttentionActionName> actions;
  final DateTime? snoozedUntil;

  /// Present on `kind: question` items (Claude's `AskUserQuestion`). Null on
  /// every other kind, and tolerated as absent even on a `question` item
  /// from an older Lee that hasn't caught up yet.
  final QuestionSet? question;

  const AttentionItem({
    required this.id,
    this.version = 0,
    this.kind = AttentionKind.waiting,
    this.severity = AttentionSeverity.ambient,
    this.state = AttentionItemState.open,
    this.parked = false,
    this.wake = false,
    this.notify = false,
    this.relatedToFocus = false,
    this.createdAt,
    this.updatedAt,
    this.activeWaitMs = 0,
    this.title = '',
    this.text = '',
    this.source = const AttentionSource(),
    this.files,
    this.tool,
    this.leeStatus,
    this.actions = const [],
    this.snoozedUntil,
    this.question,
  });

  factory AttentionItem.fromJson(Map<String, dynamic> json) {
    return AttentionItem(
      id: json['id'] as String? ?? '',
      version: (json['version'] as num?)?.toInt() ?? 0,
      kind: AttentionKind.fromWire(json['kind'] as String?),
      severity: AttentionSeverity.fromWire(json['severity'] as String?),
      state: AttentionItemState.fromWire(json['state'] as String?),
      parked: json['parked'] as bool? ?? false,
      wake: json['wake'] as bool? ?? false,
      notify: json['notify'] as bool? ?? false,
      relatedToFocus: json['related_to_focus'] as bool? ?? false,
      createdAt: _parseDate(json['created_at']),
      updatedAt: _parseDate(json['updated_at']),
      activeWaitMs: (json['active_wait_ms'] as num?)?.toInt() ?? 0,
      title: json['title'] as String? ?? '',
      text: json['text'] as String? ?? '',
      source: json['source'] != null
          ? AttentionSource.fromJson(json['source'] as Map<String, dynamic>)
          : const AttentionSource(),
      files: (json['files'] as List<dynamic>?)
          ?.map((f) => f as String)
          .toList(),
      tool: json['tool'] != null
          ? ToolPreview.fromJson(json['tool'] as Map<String, dynamic>)
          : null,
      leeStatus: json['lee_status'] != null
          ? LeeStatusBlock.fromJson(json['lee_status'] as Map<String, dynamic>)
          : null,
      actions: (json['actions'] as List<dynamic>?)
              ?.map((a) => AttentionActionName.fromWire(a as String))
              .whereType<AttentionActionName>()
              .toList() ??
          const [],
      snoozedUntil: _parseDate(json['snoozed_until']),
      question: json['question'] != null
          ? QuestionSet.fromJson(json['question'] as Map<String, dynamic>)
          : null,
    );
  }

  bool get canApproveDeny =>
      actions.contains(AttentionActionName.approve) ||
      actions.contains(AttentionActionName.deny);
  bool get canReply => actions.contains(AttentionActionName.reply);
  bool get canSnooze => actions.contains(AttentionActionName.snooze);
  bool get canDismiss => actions.contains(AttentionActionName.dismiss);
  bool get canWake => actions.contains(AttentionActionName.wake);
  bool get canChoose => actions.contains(AttentionActionName.choose);

  /// True for an `approval` item that is really Claude's `AskUserQuestion`
  /// tool wearing the old approve/deny shape (an older Lee that hasn't sent
  /// `kind: question` yet). Approve there silently accepts the highlighted
  /// option — never safe to expose as a plain "Approve" button (C3).
  bool get isLegacyAskQuestionApproval =>
      kind == AttentionKind.approval && tool?.name == 'AskUserQuestion';

  /// "tab label · workspace basename", trimmed to whichever parts exist.
  String get sourceLabel {
    final tab = source.tabLabel;
    final ws = source.workspaceName;
    if (tab != null && tab.isNotEmpty && ws != null) return '$tab · $ws';
    return tab ?? ws ?? '';
  }

  @override
  List<Object?> get props => [
        id,
        version,
        kind,
        severity,
        state,
        parked,
        wake,
        notify,
        relatedToFocus,
        createdAt,
        updatedAt,
        activeWaitMs,
        title,
        text,
        source,
        files,
        tool,
        leeStatus,
        actions,
        snoozedUntil,
        question,
      ];
}

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

enum FocusItemKind { agent, files, workspace }

/// Mirrors the shared `FocusItem` union (Appendix A) as one class with a
/// [kind] discriminant, since Dart has no built-in tagged unions.
class FocusItem extends Equatable {
  final FocusItemKind kind;
  final int? ptyId; // agent
  final int? windowId; // agent
  final String? label; // agent
  final String? workspace; // files | workspace
  final List<String> paths; // files

  const FocusItem._(
    this.kind, {
    this.ptyId,
    this.windowId,
    this.label,
    this.workspace,
    this.paths = const [],
  });

  factory FocusItem.agent({
    required int ptyId,
    int? windowId,
    required String label,
  }) =>
      FocusItem._(FocusItemKind.agent,
          ptyId: ptyId, windowId: windowId, label: label);

  factory FocusItem.files({String? workspace, List<String> paths = const []}) =>
      FocusItem._(FocusItemKind.files, workspace: workspace, paths: paths);

  factory FocusItem.workspace(String workspace) =>
      FocusItem._(FocusItemKind.workspace, workspace: workspace);

  factory FocusItem.fromJson(Map<String, dynamic> json) {
    switch (json['kind'] as String?) {
      case 'agent':
        return FocusItem.agent(
          ptyId: (json['pty_id'] as num?)?.toInt() ?? 0,
          windowId: (json['window_id'] as num?)?.toInt(),
          label: json['label'] as String? ?? '',
        );
      case 'files':
        return FocusItem.files(
          workspace: json['workspace'] as String?,
          paths: (json['paths'] as List<dynamic>?)
                  ?.map((p) => p as String)
                  .toList() ??
              const [],
        );
      case 'workspace':
      default:
        return FocusItem.workspace(json['workspace'] as String? ?? '');
    }
  }

  Map<String, dynamic> toJson() {
    switch (kind) {
      case FocusItemKind.agent:
        return {'kind': 'agent', 'pty_id': ptyId, 'window_id': windowId, 'label': label};
      case FocusItemKind.files:
        return {'kind': 'files', 'workspace': workspace, 'paths': paths};
      case FocusItemKind.workspace:
        return {'kind': 'workspace', 'workspace': workspace};
    }
  }

  String get displayLabel {
    switch (kind) {
      case FocusItemKind.agent:
        return (label == null || label!.isEmpty) ? 'Agent' : label!;
      case FocusItemKind.files:
        if (paths.isNotEmpty) return paths.map((p) => p.split('/').last).join(', ');
        return workspace?.split('/').last ?? 'Files';
      case FocusItemKind.workspace:
        return (workspace == null || workspace!.isEmpty)
            ? 'Workspace'
            : workspace!.split('/').last;
    }
  }

  @override
  List<Object?> get props => [kind, ptyId, windowId, label, workspace, paths];
}

class FocusState extends Equatable {
  final bool active;
  final String? sessionId;
  final String? source; // manual | inferred
  final DateTime? startedAt;
  final FocusItem? item;
  final int quietCount;

  const FocusState({
    this.active = false,
    this.sessionId,
    this.source,
    this.startedAt,
    this.item,
    this.quietCount = 0,
  });

  static const empty = FocusState();

  factory FocusState.fromJson(Map<String, dynamic> json) {
    return FocusState(
      active: json['active'] as bool? ?? false,
      sessionId: json['session_id'] as String?,
      source: json['source'] as String?,
      startedAt: _parseDate(json['started_at']),
      item: json['item'] != null
          ? FocusItem.fromJson(json['item'] as Map<String, dynamic>)
          : null,
      quietCount: (json['quiet_count'] as num?)?.toInt() ?? 0,
    );
  }

  @override
  List<Object?> get props =>
      [active, sessionId, source, startedAt, item, quietCount];
}

// ---------------------------------------------------------------------------
// Away / handoff (v1)
// ---------------------------------------------------------------------------

enum SummaryPolicyMode { none, onReturn, at }

class SummaryPolicy extends Equatable {
  final SummaryPolicyMode mode;
  final DateTime? at;

  const SummaryPolicy._(this.mode, [this.at]);
  const SummaryPolicy.none() : this._(SummaryPolicyMode.none);
  const SummaryPolicy.onReturn() : this._(SummaryPolicyMode.onReturn);
  const SummaryPolicy.at(DateTime at) : this._(SummaryPolicyMode.at, at);

  factory SummaryPolicy.fromJson(Map<String, dynamic> json) {
    switch (json['mode'] as String?) {
      case 'at':
        final at = _parseDate(json['at']);
        return at != null ? SummaryPolicy.at(at) : const SummaryPolicy.onReturn();
      case 'none':
        return const SummaryPolicy.none();
      case 'on_return':
      default:
        return const SummaryPolicy.onReturn();
    }
  }

  Map<String, dynamic> toJson() {
    switch (mode) {
      case SummaryPolicyMode.none:
        return {'mode': 'none'};
      case SummaryPolicyMode.onReturn:
        return {'mode': 'on_return'};
      case SummaryPolicyMode.at:
        return {'mode': 'at', 'at': at!.toUtc().toIso8601String()};
    }
  }

  @override
  List<Object?> get props => [mode, at];
}

class AwayState extends Equatable {
  final bool active;
  final String? handoffId;
  final DateTime? startedAt;
  final SummaryPolicy summary;
  final bool summaryDelivered;
  final List<String> wakeItemIds;
  final List<int> wakePtyIds;
  final int parkedCount;

  const AwayState({
    this.active = false,
    this.handoffId,
    this.startedAt,
    this.summary = const SummaryPolicy.onReturn(),
    this.summaryDelivered = false,
    this.wakeItemIds = const [],
    this.wakePtyIds = const [],
    this.parkedCount = 0,
  });

  static const empty = AwayState();

  factory AwayState.fromJson(Map<String, dynamic> json) {
    return AwayState(
      active: json['active'] as bool? ?? false,
      handoffId: json['handoff_id'] as String?,
      startedAt: _parseDate(json['started_at']),
      summary: json['summary'] != null
          ? SummaryPolicy.fromJson(json['summary'] as Map<String, dynamic>)
          : const SummaryPolicy.onReturn(),
      summaryDelivered: json['summary_delivered'] as bool? ?? false,
      wakeItemIds: (json['wake_item_ids'] as List<dynamic>?)
              ?.map((e) => e as String)
              .toList() ??
          const [],
      wakePtyIds: (json['wake_pty_ids'] as List<dynamic>?)
              ?.map((e) => (e as num).toInt())
              .toList() ??
          const [],
      parkedCount: (json['parked_count'] as num?)?.toInt() ?? 0,
    );
  }

  @override
  List<Object?> get props => [
        active,
        handoffId,
        startedAt,
        summary,
        summaryDelivered,
        wakeItemIds,
        wakePtyIds,
        parkedCount,
      ];
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

class AttentionCounts extends Equatable {
  final int blocking;
  final int needsYou;
  final int ambient;
  final int parked;

  const AttentionCounts({
    this.blocking = 0,
    this.needsYou = 0,
    this.ambient = 0,
    this.parked = 0,
  });

  static const empty = AttentionCounts();

  factory AttentionCounts.fromJson(Map<String, dynamic> json) {
    return AttentionCounts(
      blocking: (json['blocking'] as num?)?.toInt() ?? 0,
      needsYou: (json['needs_you'] as num?)?.toInt() ?? 0,
      ambient: (json['ambient'] as num?)?.toInt() ?? 0,
      parked: (json['parked'] as num?)?.toInt() ?? 0,
    );
  }

  int get needsAttention => blocking + needsYou;

  @override
  List<Object?> get props => [blocking, needsYou, ambient, parked];
}

// ---------------------------------------------------------------------------
// Running agents ("In flight")
// ---------------------------------------------------------------------------

enum AgentRunState {
  busy,
  waiting,
  idle,
  unknown;

  static AgentRunState fromWire(String? value) => switch (value) {
        'busy' => AgentRunState.busy,
        'waiting' => AgentRunState.waiting,
        'idle' => AgentRunState.idle,
        _ => AgentRunState.unknown,
      };
}

/// One running agent from the snapshot's optional `agents` list (shared
/// `AgentSummary`). Never carries prompt text or tool inputs; [lastSummary]
/// is the agent's own words, clipped to ~280 chars in compact snapshots.
class AgentSummary extends Equatable {
  final int ptyId;
  final int? windowId;
  final int? tabId;
  final String label;
  final String provider;
  final String? workspace;
  final AgentRunState state;
  final DateTime? busySince;
  final DateTime? idleSince;
  final String? lastTool;
  final String? lastSummary;
  final int filesTouchedCount;

  /// What it's doing now (cockpit design §7.1): the open tool, else the last
  /// entry within 60s. Null when idle or from an older Lee.
  final AgentNow? now;

  /// The last 8 activity entries, newest last (§7.1), for "Along the way".
  final List<AgentActivity> recent;

  /// The last 10 finished turns, newest last, for "Updates".
  final List<AgentUpdate> updates;

  /// This session's usage so far (docs/15-Usage.md §6.2); null until its
  /// first turn ends, or from an older Lee.
  final AgentUsage? usage;

  const AgentSummary({
    required this.ptyId,
    this.windowId,
    this.tabId,
    this.label = 'Claude',
    this.provider = 'claude',
    this.workspace,
    this.state = AgentRunState.unknown,
    this.busySince,
    this.idleSince,
    this.lastTool,
    this.lastSummary,
    this.filesTouchedCount = 0,
    this.now,
    this.recent = const [],
    this.updates = const [],
    this.usage,
  });

  factory AgentSummary.fromJson(Map<String, dynamic> json) {
    final label = json['label'] as String?;
    return AgentSummary(
      ptyId: (json['pty_id'] as num?)?.toInt() ?? 0,
      windowId: (json['window_id'] as num?)?.toInt(),
      tabId: (json['tab_id'] as num?)?.toInt(),
      label: (label == null || label.isEmpty) ? 'Claude' : label,
      provider: json['provider'] as String? ?? 'claude',
      workspace: json['workspace'] as String?,
      state: AgentRunState.fromWire(json['state'] as String?),
      busySince: _parseDate(json['busy_since']),
      idleSince: _parseDate(json['idle_since']),
      lastTool: json['last_tool'] as String?,
      lastSummary: json['last_summary'] as String?,
      filesTouchedCount: (json['files_touched_count'] as num?)?.toInt() ?? 0,
      now: json['now'] is Map<String, dynamic> ? AgentNow.fromJson(json['now'] as Map<String, dynamic>) : null,
      recent: (json['recent'] as List<dynamic>?)
              ?.whereType<Map<String, dynamic>>()
              .map(AgentActivity.fromJson)
              .toList() ??
          const [],
      updates: (json['updates'] as List<dynamic>?)
              ?.whereType<Map<String, dynamic>>()
              .map(AgentUpdate.fromJson)
              .toList() ??
          const [],
      usage: json['usage'] is Map<String, dynamic>
          ? AgentUsage.fromJson(json['usage'] as Map<String, dynamic>)
          : null,
    );
  }

  /// Basename of [workspace].
  String? get workspaceName {
    if (workspace == null || workspace!.isEmpty) return null;
    return workspace!.split('/').last;
  }

  @override
  List<Object?> get props => [
        ptyId,
        windowId,
        tabId,
        label,
        provider,
        workspace,
        state,
        busySince,
        idleSince,
        lastTool,
        lastSummary,
        filesTouchedCount,
        now,
        recent,
        updates,
        usage,
      ];
}

/// What an agent is doing now (shared `AgentNow`, cockpit design §7.1).
class AgentNow extends Equatable {
  final String tool;
  final String preview;
  final List<String> files;
  final DateTime? since;

  const AgentNow({required this.tool, this.preview = '', this.files = const [], this.since});

  factory AgentNow.fromJson(Map<String, dynamic> json) {
    return AgentNow(
      tool: json['tool'] as String? ?? '',
      preview: json['preview'] as String? ?? '',
      files: _strings(json['files']),
      since: _parseDate(json['since']),
    );
  }

  @override
  List<Object?> get props => [tool, preview, files, since];
}

/// One entry of an agent's activity ring (shared `AgentActivity`, §7.1).
class AgentActivity extends Equatable {
  final DateTime? at;
  final String tool;
  final String preview;
  final List<String> files;
  final bool writes;
  final bool failed;

  /// 'pre' (the tool started) or 'post' (it finished).
  final String phase;

  const AgentActivity({
    this.at,
    required this.tool,
    this.preview = '',
    this.files = const [],
    this.writes = false,
    this.failed = false,
    this.phase = 'post',
  });

  factory AgentActivity.fromJson(Map<String, dynamic> json) {
    return AgentActivity(
      at: _parseDate(json['at']),
      tool: json['tool'] as String? ?? '',
      preview: json['preview'] as String? ?? '',
      files: _strings(json['files']),
      writes: json['writes'] as bool? ?? false,
      failed: json['failed'] as bool? ?? false,
      phase: json['phase'] as String? ?? 'post',
    );
  }

  @override
  List<Object?> get props => [at, tool, preview, files, writes, failed, phase];
}

/// One finished turn, for the one-agent screen's Updates (shared `AgentUpdate`).
class AgentUpdate extends Equatable {
  final DateTime? at;
  final String? summary;
  final LeeStatusBlock? leeStatus;

  const AgentUpdate({this.at, this.summary, this.leeStatus});

  factory AgentUpdate.fromJson(Map<String, dynamic> json) {
    return AgentUpdate(
      at: _parseDate(json['at']),
      summary: json['summary'] as String?,
      leeStatus: json['lee_status'] is Map<String, dynamic>
          ? LeeStatusBlock.fromJson(json['lee_status'] as Map<String, dynamic>)
          : null,
    );
  }

  @override
  List<Object?> get props => [at, summary, leeStatus];
}

/// What a cost figure means (docs/15-Usage.md §2). Subscription usage is
/// shown as tokens only (§9).
enum CostBasis {
  billed,
  subscription,
  estimate,
  local;

  static CostBasis fromWire(String? value) => switch (value) {
        'billed' => CostBasis.billed,
        'estimate' => CostBasis.estimate,
        'local' => CostBasis.local,
        _ => CostBasis.subscription,
      };
}

/// An agent session's running usage (shared `AgentUsage`, docs/15-Usage.md
/// §6.2). [shownTokens] = input + output + cache_write, computed by Lee.
class AgentUsage extends Equatable {
  final int shownTokens;
  final CostBasis costBasis;

  /// Present only for billed and estimated spend; never shown for a subscription.
  final double? costUsd;

  const AgentUsage({required this.shownTokens, this.costBasis = CostBasis.subscription, this.costUsd});

  factory AgentUsage.fromJson(Map<String, dynamic> json) {
    return AgentUsage(
      shownTokens: (json['shown_tokens'] as num?)?.toInt() ?? 0,
      costBasis: CostBasis.fromWire(json['cost_basis'] as String?),
      costUsd: (json['cost_usd'] as num?)?.toDouble(),
    );
  }

  /// Dollars are shown only for billed or estimated spend (§2, §9).
  bool get showsDollars =>
      costUsd != null && (costBasis == CostBasis.billed || costBasis == CostBasis.estimate);

  @override
  List<Object?> get props => [shownTokens, costBasis, costUsd];
}

/// One Claude subscription window (docs/15-Usage.md §6.1).
class UsageWindow extends Equatable {
  final double usedPct;
  final DateTime? resetsAt;

  const UsageWindow({required this.usedPct, this.resetsAt});

  factory UsageWindow.fromJson(Map<String, dynamic> json) {
    return UsageWindow(
      usedPct: (json['used_pct'] as num?)?.toDouble() ?? 0,
      resetsAt: _parseDate(json['resets_at']),
    );
  }

  @override
  List<Object?> get props => [usedPct, resetsAt];
}

/// The latest Claude subscription limits (shared `UsageLimits`). Parsed so
/// the snapshot carries it; Aeronaut shows nothing from it in v1
/// (docs/15-Usage.md §6.3: devices get a limit strip only on request).
class UsageLimits extends Equatable {
  final UsageWindow? fiveHour;
  final UsageWindow? sevenDay;
  final DateTime? asOf;

  const UsageLimits({this.fiveHour, this.sevenDay, this.asOf});

  factory UsageLimits.fromJson(Map<String, dynamic> json) {
    return UsageLimits(
      fiveHour: json['five_hour'] is Map<String, dynamic>
          ? UsageWindow.fromJson(json['five_hour'] as Map<String, dynamic>)
          : null,
      sevenDay: json['seven_day'] is Map<String, dynamic>
          ? UsageWindow.fromJson(json['seven_day'] as Map<String, dynamic>)
          : null,
      asOf: _parseDate(json['as_of']),
    );
  }

  @override
  List<Object?> get props => [fiveHour, sevenDay, asOf];
}

/// The running Deep session (Deep D1 §2.5): devices show "In deep work".
class DeepSession extends Equatable {
  final String? explorationId;
  final String title;

  const DeepSession({this.explorationId, this.title = ''});

  factory DeepSession.fromJson(Map<String, dynamic> json) {
    return DeepSession(
      explorationId: json['exploration_id'] as String?,
      title: json['title'] as String? ?? '',
    );
  }

  @override
  List<Object?> get props => [explorationId, title];
}

class AttentionSnapshot extends Equatable {
  final List<AttentionItem> items;
  final AttentionCounts counts;
  final FocusState focus;
  final AwayState away;

  /// Running agents; empty when Lee is older and omits `agents`.
  final List<AgentSummary> agents;
  final DateTime? generatedAt;

  /// The focused window's mode ('cockpit' | 'deep' | 'manual'); null from an older Lee.
  final String? mode;

  /// The running Deep session, if any: the Work header says "In deep work".
  final DeepSession? deep;

  /// The latest Claude subscription limits, or null.
  final UsageLimits? limits;

  const AttentionSnapshot({
    this.items = const [],
    this.counts = AttentionCounts.empty,
    this.focus = FocusState.empty,
    this.away = AwayState.empty,
    this.agents = const [],
    this.generatedAt,
    this.mode,
    this.deep,
    this.limits,
  });

  static const empty = AttentionSnapshot();

  factory AttentionSnapshot.fromJson(Map<String, dynamic> json) {
    return AttentionSnapshot(
      items: (json['items'] as List<dynamic>?)
              ?.map((i) => AttentionItem.fromJson(i as Map<String, dynamic>))
              .toList() ??
          const [],
      counts: json['counts'] != null
          ? AttentionCounts.fromJson(json['counts'] as Map<String, dynamic>)
          : AttentionCounts.empty,
      focus: json['focus'] != null
          ? FocusState.fromJson(json['focus'] as Map<String, dynamic>)
          : FocusState.empty,
      away: json['away'] != null
          ? AwayState.fromJson(json['away'] as Map<String, dynamic>)
          : AwayState.empty,
      agents: (json['agents'] as List<dynamic>?)
              ?.whereType<Map<String, dynamic>>()
              .map(AgentSummary.fromJson)
              .toList() ??
          const [],
      generatedAt: _parseDate(json['generated_at']),
      mode: json['mode'] as String?,
      deep: json['deep'] is Map<String, dynamic>
          ? DeepSession.fromJson(json['deep'] as Map<String, dynamic>)
          : null,
      limits: json['limits'] is Map<String, dynamic>
          ? UsageLimits.fromJson(json['limits'] as Map<String, dynamic>)
          : null,
    );
  }

  AttentionSnapshot copyWith({
    List<AttentionItem>? items,
    AttentionCounts? counts,
    FocusState? focus,
    AwayState? away,
    List<AgentSummary>? agents,
    DateTime? generatedAt,
  }) {
    return AttentionSnapshot(
      items: items ?? this.items,
      counts: counts ?? this.counts,
      focus: focus ?? this.focus,
      away: away ?? this.away,
      agents: agents ?? this.agents,
      generatedAt: generatedAt ?? this.generatedAt,
      mode: mode,
      deep: deep,
      limits: limits,
    );
  }

  @override
  List<Object?> get props => [items, counts, focus, away, agents, generatedAt, mode, deep, limits];
}

// ---------------------------------------------------------------------------
// Action results
// ---------------------------------------------------------------------------

class ActionResult extends Equatable {
  final bool success;
  final String? error;
  final AttentionItem? item;

  const ActionResult({required this.success, this.error, this.item});

  factory ActionResult.fromJson(Map<String, dynamic> json) {
    return ActionResult(
      success: json['success'] as bool? ?? false,
      error: json['error'] as String?,
      item: json['item'] != null
          ? AttentionItem.fromJson(json['item'] as Map<String, dynamic>)
          : null,
    );
  }

  @override
  List<Object?> get props => [success, error, item];
}

class CaptureResult extends Equatable {
  final bool success;
  final String? somedayId;
  final bool spooled;
  final String? error;

  const CaptureResult({
    required this.success,
    this.somedayId,
    this.spooled = false,
    this.error,
  });

  factory CaptureResult.fromJson(Map<String, dynamic> json) {
    return CaptureResult(
      success: json['success'] as bool? ?? false,
      somedayId: json['someday_id'] as String?,
      spooled: json['spooled'] as bool? ?? false,
      error: json['error'] as String?,
    );
  }

  @override
  List<Object?> get props => [success, somedayId, spooled, error];
}

// ---------------------------------------------------------------------------
// Handoff (v1)
// ---------------------------------------------------------------------------

class HandoffAgent extends Equatable {
  final int ptyId;
  final int? windowId;
  final int? tabId;
  final String label;
  final String provider;
  final String? workspace;
  final String state; // busy | idle | waiting | unknown
  final String? lastSummary;

  const HandoffAgent({
    required this.ptyId,
    this.windowId,
    this.tabId,
    this.label = '',
    this.provider = 'claude',
    this.workspace,
    this.state = 'unknown',
    this.lastSummary,
  });

  factory HandoffAgent.fromJson(Map<String, dynamic> json) {
    return HandoffAgent(
      ptyId: (json['pty_id'] as num?)?.toInt() ?? 0,
      windowId: (json['window_id'] as num?)?.toInt(),
      tabId: (json['tab_id'] as num?)?.toInt(),
      label: json['label'] as String? ?? 'Agent',
      provider: json['provider'] as String? ?? 'claude',
      workspace: json['workspace'] as String?,
      state: json['state'] as String? ?? 'unknown',
      lastSummary: json['last_summary'] as String?,
    );
  }

  bool get isIdle => state == 'idle';

  @override
  List<Object?> get props =>
      [ptyId, windowId, tabId, label, provider, workspace, state, lastSummary];
}

class HandoffProposals extends Equatable {
  final List<HandoffAgent> agents;
  final List<AttentionItem> waiting;
  final List<String> workspaces;
  final SummaryPolicy defaultSummary;

  const HandoffProposals({
    this.agents = const [],
    this.waiting = const [],
    this.workspaces = const [],
    this.defaultSummary = const SummaryPolicy.onReturn(),
  });

  static const empty = HandoffProposals();

  factory HandoffProposals.fromJson(Map<String, dynamic> json) {
    return HandoffProposals(
      agents: (json['agents'] as List<dynamic>?)
              ?.map((a) => HandoffAgent.fromJson(a as Map<String, dynamic>))
              .toList() ??
          const [],
      waiting: (json['waiting'] as List<dynamic>?)
              ?.map((w) => AttentionItem.fromJson(w as Map<String, dynamic>))
              .toList() ??
          const [],
      workspaces: (json['workspaces'] as List<dynamic>?)
              ?.map((w) => w as String)
              .toList() ??
          const [],
      defaultSummary: json['default_summary'] != null
          ? SummaryPolicy.fromJson(json['default_summary'] as Map<String, dynamic>)
          : const SummaryPolicy.onReturn(),
    );
  }

  @override
  List<Object?> get props => [agents, waiting, workspaces, defaultSummary];
}

class HandoffLaunch extends Equatable {
  final String workspace;
  final String prompt;
  final String? title;
  final bool worktree;
  final String permissionMode; // acceptEdits | default | plan

  const HandoffLaunch({
    required this.workspace,
    required this.prompt,
    this.title,
    this.worktree = true,
    this.permissionMode = 'acceptEdits',
  });

  Map<String, dynamic> toJson() => {
        'workspace': workspace,
        'prompt': prompt,
        if (title != null && title!.isNotEmpty) 'title': title,
        'worktree': worktree,
        'permission_mode': permissionMode,
      };

  @override
  List<Object?> get props => [workspace, prompt, title, worktree, permissionMode];
}

class HandoffFollowup extends Equatable {
  final int ptyId;
  final String text;

  const HandoffFollowup({required this.ptyId, required this.text});

  Map<String, dynamic> toJson() => {'pty_id': ptyId, 'text': text};

  @override
  List<Object?> get props => [ptyId, text];
}

class HandoffRequest extends Equatable {
  final List<HandoffFollowup> followups;
  final List<HandoffLaunch> launch;
  final SummaryPolicy summary;
  final List<String> wakeItemIds;
  final List<int> wakePtyIds;
  final String? note;

  const HandoffRequest({
    this.followups = const [],
    this.launch = const [],
    this.summary = const SummaryPolicy.onReturn(),
    this.wakeItemIds = const [],
    this.wakePtyIds = const [],
    this.note,
  });

  Map<String, dynamic> toJson() => {
        'followups': followups.map((f) => f.toJson()).toList(),
        'launch': launch.map((l) => l.toJson()).toList(),
        'summary': summary.toJson(),
        'wake': {'item_ids': wakeItemIds, 'pty_ids': wakePtyIds},
        if (note != null && note!.isNotEmpty) 'note': note,
      };

  @override
  List<Object?> get props => [followups, launch, summary, wakeItemIds, wakePtyIds, note];
}

class HandoffResult extends Equatable {
  final bool success;
  final AwayState? away;
  final int? launched;
  final String? error;

  const HandoffResult({required this.success, this.away, this.launched, this.error});

  factory HandoffResult.fromJson(Map<String, dynamic> json) {
    return HandoffResult(
      success: json['success'] as bool? ?? false,
      away: json['away'] != null
          ? AwayState.fromJson(json['away'] as Map<String, dynamic>)
          : null,
      launched: (json['launched'] as num?)?.toInt(),
      error: json['error'] as String?,
    );
  }

  @override
  List<Object?> get props => [success, away, launched, error];
}

// ---------------------------------------------------------------------------
// Presence and return (multiplexed onto /context/stream — contracts §3.3)
// ---------------------------------------------------------------------------

class PresenceState extends Equatable {
  final bool atMachine;
  final bool leeActive;
  final bool engaged;
  final String? engagedVia;
  final DateTime? awaySince;

  const PresenceState({
    this.atMachine = true,
    this.leeActive = true,
    this.engaged = true,
    this.engagedVia,
    this.awaySince,
  });

  factory PresenceState.fromJson(Map<String, dynamic> json) {
    return PresenceState(
      atMachine: json['at_machine'] as bool? ?? true,
      leeActive: json['lee_active'] as bool? ?? true,
      engaged: json['engaged'] as bool? ?? true,
      engagedVia: json['engaged_via'] as String?,
      awaySince: _parseDate(json['away_since']),
    );
  }

  @override
  List<Object?> get props => [atMachine, leeActive, engaged, engagedVia, awaySince];
}

class ReturnInfo extends Equatable {
  final String reason; // handoff_end | presence
  final DateTime? awaySince;
  final DateTime? returnedAt;
  final int awayMs;
  final String? handoffId;

  const ReturnInfo({
    required this.reason,
    this.awaySince,
    this.returnedAt,
    this.awayMs = 0,
    this.handoffId,
  });

  factory ReturnInfo.fromJson(Map<String, dynamic> json) {
    return ReturnInfo(
      reason: json['reason'] as String? ?? 'presence',
      awaySince: _parseDate(json['away_since']),
      returnedAt: _parseDate(json['returned_at']),
      awayMs: (json['away_ms'] as num?)?.toInt() ?? 0,
      handoffId: json['handoff_id'] as String?,
    );
  }

  @override
  List<Object?> get props => [reason, awaySince, returnedAt, awayMs, handoffId];
}

DateTime? _parseDate(dynamic value) {
  if (value is String && value.isNotEmpty) return DateTime.tryParse(value);
  return null;
}

List<String> _strings(dynamic value) =>
    (value as List<dynamic>?)?.whereType<String>().toList() ?? const [];
