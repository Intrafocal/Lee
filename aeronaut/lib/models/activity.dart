/// Pure wording shared with Lee: ports of `describeActivity`, `formatTokens`
/// (`electron/src/shared/cockpit.ts`) and `workLine`
/// (`electron/src/renderer/lib/cockpitModel.ts`). Keep the tables in step
/// with those files; `test/activity_test.dart` pins the same cases.
library;

import 'attention.dart';

/// Which way a phrase reads: "Editing" (now) or "Edited" (past, for "Along
/// the way").
enum ActivityTense { now, past }

const _editTools = {'Edit', 'Write', 'MultiEdit', 'NotebookEdit'};
const _searchTools = {'Grep', 'Glob'};
const _webTools = {'WebFetch', 'WebSearch'};
const _subagentTools = {'Task', 'Agent'};
const _searchPatternMax = 30;

String _baseName(String path) {
  final parts = path.replaceAll(RegExp(r'[\\/]+$'), '').split(RegExp(r'[\\/]'));
  final last = parts.isEmpty ? '' : parts.last;
  return last.isEmpty ? path : last;
}

/// "Editing main.ts", "Editing 3 files", or the bare verb when nothing names a file.
String _onFiles(String verb, List<String> files, String preview) {
  if (files.length > 1) return '$verb ${files.length} files';
  final one = files.isNotEmpty ? files.first : preview.trim();
  return one.isNotEmpty ? '$verb ${_baseName(one)}' : verb;
}

/// Leading `cd <dir> &&` / `cd <dir>;` segments: they say where, not what.
final _leadingCd = RegExp(r'''^\s*cd(?:\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+))?\s*(?:&&|;)\s*''');

/// The command after any leading `cd <dir> &&` / `cd <dir>;` segments (the
/// whole command when nothing follows).
String stripLeadingCd(String command) {
  var rest = command;
  for (var m = _leadingCd.firstMatch(rest);
      m != null && rest.substring(m.end).trim().isNotEmpty;
      m = _leadingCd.firstMatch(rest)) {
    rest = rest.substring(m.end);
  }
  return rest;
}

final _envAssign = RegExp(r'^[A-Za-z_][A-Za-z0-9_]*=');
final _testWords = RegExp(r'\b(test|tests|pytest|jest|vitest|smoke)\b');
final _buildWords = RegExp(r'\b(build|dist|tsc)\b|\bidf\.py\b');

/// A Bash command in words: tests, builds and git by name, else its first word.
String _describeCommand(String full, bool past) {
  final command = stripLeadingCd(full);
  final words = command.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty && !_envAssign.hasMatch(w)).toList();
  final first = words.isNotEmpty ? _baseName(words.first) : '';
  if (first == 'git') return past ? 'Used git' : 'Using git';
  final lower = command.toLowerCase();
  if (_testWords.hasMatch(lower)) return past ? 'Ran tests' : 'Running tests';
  if (_buildWords.hasMatch(lower)) return past ? 'Built' : 'Building';
  if (first.isEmpty) return past ? 'Ran a command' : 'Running a command';
  return '${past ? 'Ran' : 'Running'} $first';
}

/// A tool call as a short phrase (cockpit design §7.1): present tense for
/// "what it's doing now", past tense for "Along the way". A failed entry
/// gets " (failed)".
String describeActivity({
  required String tool,
  String preview = '',
  List<String> files = const [],
  bool failed = false,
  ActivityTense tense = ActivityTense.now,
}) {
  final past = tense == ActivityTense.past;
  String phrase;
  if (_editTools.contains(tool)) {
    phrase = _onFiles(past ? 'Edited' : 'Editing', files, preview);
  } else if (tool == 'Read') {
    phrase = _onFiles(past ? 'Read' : 'Reading', files, preview);
  } else if (_searchTools.contains(tool)) {
    final p = preview.trim();
    // toolPreview prefers a path over the pattern; a path or JSON is not a pattern.
    final pattern =
        p.isNotEmpty && p != tool && p.length <= _searchPatternMax && !RegExp(r'^[/~{\[]').hasMatch(p) ? p : '';
    phrase = '${past ? 'Searched' : 'Searching'}${pattern.isNotEmpty ? ' for $pattern' : ''}';
  } else if (tool == 'Bash') {
    phrase = _describeCommand(preview, past);
  } else if (_webTools.contains(tool)) {
    phrase = past ? 'Read the web' : 'Reading the web';
  } else if (_subagentTools.contains(tool)) {
    phrase = past ? 'Worked with a subagent' : 'Working with a subagent';
  } else if (tool == 'AskUserQuestion') {
    phrase = past ? 'Asked you a question' : 'Asking you a question';
  } else {
    phrase = tool;
  }
  return failed ? '$phrase (failed)' : phrase;
}

/// [describeActivity] for what an agent is doing now.
String describeNow(AgentNow now) =>
    describeActivity(tool: now.tool, preview: now.preview, files: now.files);

/// [describeActivity] in the past tense, for an "Along the way" entry.
String describePast(AgentActivity a) => describeActivity(
      tool: a.tool,
      preview: a.preview,
      files: a.files,
      failed: a.failed,
      tense: ActivityTense.past,
    );

/// "412 tok", "412k tok", "1.2M tok": the compact token label used in Work
/// (docs/15-Usage.md §6.2). Empty for a negative count.
String formatTokens(num n) {
  if (!n.isFinite || n < 0) return '';
  if (n < 1000) return '${n.round()} tok';
  if (n < 1000000) return '${(n / 1000).round()}k tok';
  return '${(n / 1000000).toStringAsFixed(n < 10000000 ? 1 : 0)}M tok';
}

/// The one-agent screen's usage line (§6.2): "412k tokens" for subscription
/// runs, "412k tokens · $3.10" for billed or estimated spend. Null when
/// there's nothing to show.
String? usageLine(AgentUsage? usage) {
  if (usage == null || usage.shownTokens <= 0) return null;
  final tokens = formatTokens(usage.shownTokens).replaceFirst(RegExp(r' tok$'), ' tokens');
  if (!usage.showsDollars) return tokens;
  return '$tokens · \$${usage.costUsd!.toStringAsFixed(2)}';
}

const _numberWords = [
  'no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', //
];

/// A count in words ("two"), digits past twelve; [capital] for the start of a sentence.
String numberWord(int n, {bool capital = false}) {
  final w = n >= 0 && n < _numberWords.length ? _numberWords[n] : '$n';
  return capital ? '${w[0].toUpperCase()}${w.substring(1)}' : w;
}

/// Work's headline: "One thing needs you." / "Two things need you." while
/// anything is waiting, else "Working on it." while agents are busy, else
/// "All clear."
String workLine({required int waiting, int working = 0}) {
  final w = waiting < 0 ? 0 : waiting;
  if (w > 0) return '${numberWord(w, capital: true)} ${w == 1 ? 'thing needs' : 'things need'} you.';
  return working > 0 ? 'Working on it.' : 'All clear.';
}
