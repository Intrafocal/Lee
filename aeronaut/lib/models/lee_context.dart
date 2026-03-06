import 'package:equatable/equatable.dart';

/// Tab types from Lee's context.ts
enum TabType {
  editor,
  terminal,
  git,
  docker,
  k8s,
  flutter,
  hester,
  claude,
  files,
  browser,
  hesterQa,
  devops,
  system,
  sql,
  library;

  static TabType fromString(String value) {
    switch (value) {
      case 'hester-qa':
        return TabType.hesterQa;
      default:
        return TabType.values.firstWhere(
          (t) => t.name == value,
          orElse: () => TabType.terminal,
        );
    }
  }
}

/// Dock position for multi-panel layout
enum DockPosition { center, left, right, bottom }

/// Tab activity state
enum TabState { active, background, idle }

/// A single tab in Lee
class TabContext extends Equatable {
  final int id;
  final TabType type;
  final String label;
  final int? ptyId;
  final DockPosition dockPosition;
  final TabState state;

  const TabContext({
    required this.id,
    required this.type,
    required this.label,
    this.ptyId,
    this.dockPosition = DockPosition.center,
    this.state = TabState.active,
  });

  factory TabContext.fromJson(Map<String, dynamic> json) {
    return TabContext(
      id: (json['id'] as num).toInt(),
      type: TabType.fromString(json['type'] as String),
      label: json['label'] as String,
      ptyId: (json['ptyId'] as num?)?.toInt(),
      dockPosition: DockPosition.values.firstWhere(
        (p) => p.name == json['dockPosition'],
        orElse: () => DockPosition.center,
      ),
      state: TabState.values.firstWhere(
        (s) => s.name == json['state'],
        orElse: () => TabState.active,
      ),
    );
  }

  @override
  List<Object?> get props => [id, type, label, ptyId, dockPosition, state];
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
        browsers,
        activity,
        availableTuis,
        timestamp,
      ];
}
