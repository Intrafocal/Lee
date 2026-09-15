import 'package:equatable/equatable.dart';

/// Tab types from Lee's `electron/src/shared/context.ts` (`TabType`) and the
/// wider `Tab['type']` union in `electron/src/renderer/components/TabBar.tsx`.
///
/// [unknown] is the fallback for a type Lee gained that this build of Aeronaut
/// does not know about. Unknown tabs render as a read-only generic tab view,
/// never as a terminal — see `TabContext.opensTerminal`.
enum TabType {
  editor,
  editorPanel,
  file,
  terminal,
  git,
  docker,
  k8s,
  flutter,
  hester,
  claude,
  agent,
  files,
  browser,
  hesterQa,
  devops,
  system,
  sql,
  library,
  workstream,
  spyglass,
  bridge,
  kicad,
  model,
  pdf,
  binary,
  custom,
  unknown;

  /// Wire values that do not match an enum name directly.
  static const _aliases = <String, TabType>{
    'hester-qa': TabType.hesterQa,
    'editor-panel': TabType.editorPanel,
  };

  static TabType fromString(String value) {
    final alias = _aliases[value];
    if (alias != null) return alias;
    for (final t in TabType.values) {
      if (t.name == value) return t;
    }
    return TabType.unknown;
  }

  /// The wire value Lee uses for this type.
  String get wireName {
    for (final entry in _aliases.entries) {
      if (entry.value == this) return entry.key;
    }
    return name;
  }

  /// Human label for the type badge.
  String get label {
    switch (this) {
      case TabType.editor:
      case TabType.editorPanel:
        return 'Editor';
      case TabType.file:
        return 'File';
      case TabType.terminal:
        return 'Terminal';
      case TabType.git:
        return 'Git';
      case TabType.docker:
        return 'Docker';
      case TabType.k8s:
        return 'Kubernetes';
      case TabType.flutter:
        return 'Flutter';
      case TabType.hester:
        return 'Hester';
      case TabType.claude:
        return 'Claude';
      case TabType.agent:
        return 'Agent';
      case TabType.files:
        return 'Files';
      case TabType.browser:
        return 'Browser';
      case TabType.hesterQa:
        return 'Hester QA';
      case TabType.devops:
        return 'DevOps';
      case TabType.system:
        return 'System';
      case TabType.sql:
        return 'SQL';
      case TabType.library:
        return 'Library';
      case TabType.workstream:
        return 'Workstream';
      case TabType.spyglass:
        return 'Spyglass';
      case TabType.bridge:
        return 'Bridge';
      case TabType.kicad:
        return 'KiCad';
      case TabType.model:
        return '3D Model';
      case TabType.pdf:
        return 'PDF';
      case TabType.binary:
        return 'Binary';
      case TabType.custom:
        return 'Custom';
      case TabType.unknown:
        return 'Tab';
    }
  }

  /// True for the agent-style types that can hold a Hester conversation
  /// when no PTY is attached.
  bool get isAgentLike =>
      this == TabType.hester ||
      this == TabType.hesterQa ||
      this == TabType.claude ||
      this == TabType.agent;

  /// True for the types whose content is a file buffer, not a process.
  bool get isEditorLike =>
      this == TabType.editor ||
      this == TabType.editorPanel ||
      this == TabType.file;
}

/// Dock position for multi-panel layout
enum DockPosition { center, left, right, bottom }

/// Tab activity state
enum TabState { active, background, idle }

/// A single tab in Lee
class TabContext extends Equatable {
  final int id;
  final TabType type;

  /// The raw `type` string as sent by Lee. Kept so an [TabType.unknown] tab
  /// can still name itself in the UI.
  final String rawType;
  final String label;
  final int? ptyId;
  final DockPosition dockPosition;
  final TabState state;

  /// For agent tabs: which provider is running ('hester', 'claude', 'pi', ...).
  ///
  /// Not currently sent by Lee's context stream (only `id`, `type`, `label`,
  /// `ptyId`, `dockPosition`, `state` are — see `App.tsx`'s
  /// `lee.context.update()` call). Parsed defensively so this keeps working
  /// the day Lee starts sending it; until then this is always null and the
  /// type badge for agent tabs shows only the generic "Agent" label.
  final String? provider;

  /// File path for file-backed tabs (file/editor/editor-panel/kicad/model/
  /// pdf/binary). Not currently sent as a top-level tab field either — for
  /// editor-like tabs, prefer `LeeContext.editorFor(tab)` which reads the
  /// real per-tab `editors` map Lee does send. Kept here, parsed
  /// defensively, as a forward-compatible fallback and so a future Lee
  /// build that adds it to the tab payload needs no client change.
  final String? filePath;

  /// URL for browser tabs. Prefer `LeeContext.browsers[tab.id]`, which Lee
  /// does send; kept here defensively for the same reason as [filePath].
  final String? browserUrl;

  const TabContext({
    required this.id,
    required this.type,
    required this.label,
    String? rawType,
    this.ptyId,
    this.dockPosition = DockPosition.center,
    this.state = TabState.active,
    this.provider,
    this.filePath,
    this.browserUrl,
  }) : rawType = rawType ?? '';

  /// A tab opens the xterm view only when Lee actually gave it a PTY.
  ///
  /// This is deliberately keyed on [ptyId] rather than on [type]: viewer tabs
  /// (pdf, model, kicad, binary) and React panes (files, library, workstream)
  /// have no process behind them and would render as a blank terminal.
  bool get opensTerminal => ptyId != null;

  /// Label for the type badge, preferring the raw wire name for unknown types.
  String get typeLabel {
    if (type == TabType.unknown && rawType.isNotEmpty) return rawType;
    if (type == TabType.agent && provider != null && provider!.isNotEmpty) {
      return 'Agent (${provider!})';
    }
    return type.label;
  }

  factory TabContext.fromJson(Map<String, dynamic> json) {
    final raw = json['type'] as String? ?? '';
    return TabContext(
      id: (json['id'] as num).toInt(),
      type: TabType.fromString(raw),
      rawType: raw,
      label: json['label'] as String? ?? raw,
      // Lee sends `ptyId`; older builds and the Python clients use `pty_id`.
      ptyId: (json['ptyId'] as num?)?.toInt() ??
          (json['pty_id'] as num?)?.toInt(),
      dockPosition: DockPosition.values.firstWhere(
        (p) => p.name == json['dockPosition'],
        orElse: () => DockPosition.center,
      ),
      state: TabState.values.firstWhere(
        (s) => s.name == json['state'],
        orElse: () => TabState.active,
      ),
      provider: json['provider'] as String?,
      filePath: json['filePath'] as String? ?? json['file_path'] as String?,
      browserUrl: json['browserUrl'] as String? ?? json['browser_url'] as String?,
    );
  }

  @override
  List<Object?> get props => [
        id,
        type,
        rawType,
        label,
        ptyId,
        dockPosition,
        state,
        provider,
        filePath,
        browserUrl,
      ];
}

/// Panel state in Lee's layout
class PanelContext extends Equatable {
  final int? activeTabId;
  final bool visible;
  final double size;

  const PanelContext({
    this.activeTabId,
    this.visible = true,
    this.size = 100,
  });

  factory PanelContext.fromJson(Map<String, dynamic> json) {
    return PanelContext(
      activeTabId: (json['activeTabId'] as num?)?.toInt(),
      visible: json['visible'] as bool? ?? true,
      size: (json['size'] as num?)?.toDouble() ?? 100,
    );
  }

  @override
  List<Object?> get props => [activeTabId, visible, size];
}

/// Cursor position in the editor
class CursorPosition extends Equatable {
  final int line;
  final int column;

  const CursorPosition({this.line = 0, this.column = 0});

  factory CursorPosition.fromJson(Map<String, dynamic> json) {
    return CursorPosition(
      line: (json['line'] as num?)?.toInt() ?? 0,
      column: (json['column'] as num?)?.toInt() ?? 0,
    );
  }

  @override
  List<Object?> get props => [line, column];
}

/// Editor state from Lee's editor TUI
class EditorContext extends Equatable {
  final String? file;
  final String? language;
  final CursorPosition cursor;
  final String? selection;
  final bool modified;

  const EditorContext({
    this.file,
    this.language,
    this.cursor = const CursorPosition(),
    this.selection,
    this.modified = false,
  });

  /// File name without path
  String? get fileName {
    if (file == null) return null;
    return file!.split('/').last;
  }

  factory EditorContext.fromJson(Map<String, dynamic> json) {
    return EditorContext(
      file: json['file'] as String?,
      language: json['language'] as String?,
      cursor: json['cursor'] != null
          ? CursorPosition.fromJson(json['cursor'] as Map<String, dynamic>)
          : const CursorPosition(),
      selection: json['selection'] as String?,
      modified: json['modified'] as bool? ?? false,
    );
  }

  @override
  List<Object?> get props => [file, language, cursor, selection, modified];
}

/// Activity context for user tracking
class ActivityContext extends Equatable {
  final int lastInteraction;
  final int idleSeconds;
  final int sessionDuration;

  const ActivityContext({
    this.lastInteraction = 0,
    this.idleSeconds = 0,
    this.sessionDuration = 0,
  });

  factory ActivityContext.fromJson(Map<String, dynamic> json) {
    return ActivityContext(
      lastInteraction: (json['lastInteraction'] as num?)?.toInt() ?? 0,
      idleSeconds: (json['idleSeconds'] as num?)?.toInt() ?? 0,
      sessionDuration: (json['sessionDuration'] as num?)?.toInt() ?? 0,
    );
  }

  @override
  List<Object?> get props => [lastInteraction, idleSeconds, sessionDuration];
}

/// Browser tab state
class BrowserContext extends Equatable {
  final String url;
  final String title;
  final bool loading;

  const BrowserContext({
    this.url = '',
    this.title = '',
    this.loading = false,
  });

  factory BrowserContext.fromJson(Map<String, dynamic> json) {
    return BrowserContext(
      url: json['url'] as String? ?? '',
      title: json['title'] as String? ?? '',
      loading: json['loading'] as bool? ?? false,
    );
  }

  @override
  List<Object?> get props => [url, title, loading];
}

/// A TUI definition from Lee's availableTuis context.
class AvailableTui extends Equatable {
  final String key;
  final String command;
  final String name;
  final String? icon;
  final String? shortcut;

  const AvailableTui({
    required this.key,
    required this.command,
    required this.name,
    this.icon,
    this.shortcut,
  });

  factory AvailableTui.fromJson(String key, Map<String, dynamic> json) {
    return AvailableTui(
      key: key,
      command: json['command'] as String? ?? '',
      name: json['name'] as String? ?? key,
      icon: json['icon'] as String?,
      shortcut: json['shortcut'] as String?,
    );
  }

  @override
  List<Object?> get props => [key, command, name, icon, shortcut];
}

/// Full Lee context - complete IDE state snapshot
class LeeContext extends Equatable {
  final String workspace;
  final Map<DockPosition, PanelContext?> panels;
  final DockPosition focusedPanel;
  final List<TabContext> tabs;
  final EditorContext? editor;

  /// Every open editor panel, keyed by tab id (Lee's `context.editors`).
  /// This is the real per-tab source of a file tab's path/language/cursor —
  /// unlike `TabContext.filePath`, this one is actually on the wire.
  final Map<int, EditorContext> editors;
  final Map<int, BrowserContext>? browsers;
  final ActivityContext activity;
  final List<AvailableTui> availableTuis;
  final int timestamp;

  const LeeContext({
    this.workspace = '',
    this.panels = const {},
    this.focusedPanel = DockPosition.center,
    this.tabs = const [],
    this.editor,
    this.editors = const {},
    this.browsers,
    this.activity = const ActivityContext(),
    this.availableTuis = const [],
    this.timestamp = 0,
  });

  /// The currently focused tab (in the focused panel)
  TabContext? get activeTab {
    final panel = panels[focusedPanel];
    if (panel?.activeTabId == null) return null;
    try {
      return tabs.firstWhere((t) => t.id == panel!.activeTabId);
    } catch (_) {
      return null;
    }
  }

  /// Workspace name (last path segment)
  String get workspaceName => workspace.split('/').last;

  /// The real editor state for a given tab: `editors[tab.id]` when Lee sent
  /// one, else the single legacy `editor` field when there's exactly one
  /// editor-like tab open (the OSC-based path predates per-tab `editors`
  /// and never carries a tab id), else null.
  EditorContext? editorFor(TabContext tab) {
    final perTab = editors[tab.id];
    if (perTab != null) return perTab;
    if (editors.isEmpty && tab.type.isEditorLike) return editor;
    return null;
  }

  factory LeeContext.fromJson(Map<String, dynamic> json) {
    // Parse panels
    final panelsJson = json['panels'] as Map<String, dynamic>? ?? {};
    final panels = <DockPosition, PanelContext?>{};
    for (final pos in DockPosition.values) {
      final data = panelsJson[pos.name];
      panels[pos] =
          data != null ? PanelContext.fromJson(data as Map<String, dynamic>) : null;
    }

    // Parse tabs
    final tabsList = (json['tabs'] as List<dynamic>? ?? [])
        .map((t) => TabContext.fromJson(t as Map<String, dynamic>))
        .toList();

    // Parse per-tab editors (D10: this was already on the wire but ignored)
    final editorsJson = json['editors'] as Map<String, dynamic>?;
    final editors = <int, EditorContext>{};
    if (editorsJson != null) {
      for (final entry in editorsJson.entries) {
        final tabId = int.tryParse(entry.key);
        if (tabId == null) continue;
        editors[tabId] =
            EditorContext.fromJson(entry.value as Map<String, dynamic>);
      }
    }

    // Parse browsers
    Map<int, BrowserContext>? browsers;
    if (json['browsers'] != null) {
      final browsersJson = json['browsers'] as Map<String, dynamic>;
      browsers = browsersJson.map((key, value) => MapEntry(
            int.parse(key),
            BrowserContext.fromJson(value as Map<String, dynamic>),
          ));
    }

    // Parse availableTuis
    final availableTuis = <AvailableTui>[];
    final tuisJson = json['availableTuis'] as Map<String, dynamic>?;
    if (tuisJson != null) {
      for (final entry in tuisJson.entries) {
        availableTuis.add(AvailableTui.fromJson(
          entry.key,
          entry.value as Map<String, dynamic>,
        ));
      }
    }

    return LeeContext(
      workspace: json['workspace'] as String? ?? '',
      panels: panels,
      focusedPanel: DockPosition.values.firstWhere(
        (p) => p.name == json['focusedPanel'],
        orElse: () => DockPosition.center,
      ),
      tabs: tabsList,
      editor: json['editor'] != null
          ? EditorContext.fromJson(json['editor'] as Map<String, dynamic>)
          : null,
      editors: editors,
      browsers: browsers,
      activity: json['activity'] != null
          ? ActivityContext.fromJson(json['activity'] as Map<String, dynamic>)
          : const ActivityContext(),
      availableTuis: availableTuis,
      timestamp: (json['timestamp'] as num?)?.toInt() ?? 0,
    );
  }

  @override
  List<Object?> get props => [
        workspace,
        panels,
        focusedPanel,
        tabs,
        editor,
        editors,
        browsers,
        activity,
        availableTuis,
        timestamp,
      ];
}
