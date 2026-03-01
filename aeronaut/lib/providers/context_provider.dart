import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/lee_context.dart';
import 'connection_provider.dart';

/// Exposes the latest LeeContext from the active WebSocket connection.
///
/// Auto-disposes when no longer watched. Updates every time a
/// context_update message arrives from the WebSocket stream.
final leeContextProvider = StreamProvider.autoDispose<LeeContext>((ref) {
  final connection = ref.watch(connectionProvider.notifier);
  return connection.contextStream;
});

/// Convenience: the current list of tabs.
final tabsProvider = Provider.autoDispose<List<TabContext>>((ref) {
  final ctx = ref.watch(leeContextProvider).valueOrNull;
  return ctx?.tabs ?? [];
});

/// Convenience: the current editor state.
final editorProvider = Provider.autoDispose<EditorContext?>((ref) {
  final ctx = ref.watch(leeContextProvider).valueOrNull;
  return ctx?.editor;
});

/// Convenience: workspace name.
final workspaceNameProvider = Provider.autoDispose<String>((ref) {
  final ctx = ref.watch(leeContextProvider).valueOrNull;
  return ctx?.workspaceName ?? '';
});
