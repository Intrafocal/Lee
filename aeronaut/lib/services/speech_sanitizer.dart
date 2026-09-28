/// Turns markdown meant for the screen into text meant for the ear
/// (docs/plans/2026-09-28-tether-review-voice.md §5.5). Deterministic;
/// `test/speech_sanitizer_test.dart` pins the vectors. In order:
///
/// 1. A code fence becomes "a N-line `Language` snippet".
/// 2. A table becomes "a table with N rows"; a link keeps its text; a bare
///    URL becomes "a link to `host`".
/// 3. Inline code loses its backticks; paths become basenames; camelCase
///    and snake_case are split.
/// 4. Markdown syntax is stripped.
/// 5. Cut at a sentence boundary around 600 chars, ending "More on screen."
library;

/// Where readback stops ([speechLimit] chars, give or take a sentence).
const speechLimit = 600;
const moreOnScreen = 'More on screen.';

String sanitizeForSpeech(String markdown) {
  var text = markdown.replaceAll('\r\n', '\n');
  // What the steps below write is already speech: held aside so a later
  // step doesn't split "JavaScript" or strip it again.
  final held = <String>[];
  String hold(String spoken) {
    held.add(spoken);
    return '\u0000${held.length - 1}\u0000';
  }

  text = _codeFences(text, hold);
  text = _tables(text, hold);
  text = _links(text);
  text = _inlineCode(text);
  text = _paths(text);
  text = _identifiers(text);
  text = _stripMarkdown(text);
  text = text.replaceAllMapped(RegExp('\u0000(\\d+)\u0000'), (m) => held[int.parse(m.group(1)!)]);
  return _cut(text);
}

const _languages = {
  'py': 'Python',
  'python': 'Python',
  'js': 'JavaScript',
  'javascript': 'JavaScript',
  'jsx': 'JavaScript',
  'ts': 'TypeScript',
  'typescript': 'TypeScript',
  'tsx': 'TypeScript',
  'sh': 'shell',
  'bash': 'shell',
  'zsh': 'shell',
  'shell': 'shell',
  'console': 'shell',
  'json': 'JSON',
  'yaml': 'YAML',
  'yml': 'YAML',
  'sql': 'SQL',
  'html': 'HTML',
  'css': 'CSS',
  'md': 'Markdown',
  'markdown': 'Markdown',
  'cpp': 'C++',
  'c++': 'C++',
  'c': 'C',
  'rs': 'Rust',
  'rust': 'Rust',
  'go': 'Go',
  'dart': 'Dart',
  'kt': 'Kotlin',
  'swift': 'Swift',
  'diff': 'diff',
};

/// "a" or "an" before a spoken number ("an 8-line", "an 11-line").
String _article(int n) {
  final s = '$n';
  return s.startsWith('8') || n == 11 || n == 18 ? 'an' : 'a';
}

String _codeFences(String text, String Function(String) hold) {
  final fence = RegExp(r'^[ \t]*(```|~~~)[ \t]*([^\s`]*)[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$', multiLine: true);
  text = text.replaceAllMapped(fence, (m) {
    final info = (m.group(2) ?? '').toLowerCase();
    final body = m.group(3) ?? '';
    final lines = body.split('\n').where((l) => l.trim().isNotEmpty).length;
    final lang = info.isEmpty ? '' : '${_languages[info] ?? info[0].toUpperCase() + info.substring(1)} ';
    return '\n${hold('${_article(lines)} $lines-line ${lang}snippet')}.\n';
  });
  // An unclosed fence (a cut-off answer): the rest is code.
  final open = RegExp(r'^[ \t]*(```|~~~)[ \t]*([^\s`]*)[^\n]*\n?([\s\S]*)$', multiLine: true).firstMatch(text);
  if (open != null) {
    final info = (open.group(2) ?? '').toLowerCase();
    final lines = (open.group(3) ?? '').split('\n').where((l) => l.trim().isNotEmpty).length;
    final lang = info.isEmpty ? '' : '${_languages[info] ?? info[0].toUpperCase() + info.substring(1)} ';
    text = '${text.substring(0, open.start)}\n${hold('${_article(lines)} $lines-line ${lang}snippet')}.\n';
  }
  return text;
}

String _tables(String text, String Function(String) hold) {
  final lines = text.split('\n');
  final out = <String>[];
  final separator = RegExp(r'^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$');
  var i = 0;
  while (i < lines.length) {
    final isHeader = lines[i].contains('|') && i + 1 < lines.length && separator.hasMatch(lines[i + 1]);
    if (!isHeader) {
      out.add(lines[i]);
      i++;
      continue;
    }
    var j = i + 2;
    while (j < lines.length && lines[j].contains('|') && lines[j].trim().isNotEmpty) {
      j++;
    }
    final rows = j - (i + 2);
    out.add('${hold('${_article(rows)} table with $rows ${rows == 1 ? 'row' : 'rows'}')}.');
    i = j;
  }
  return out.join('\n');
}

String _host(String url) {
  final uri = Uri.tryParse(url);
  var host = uri?.host ?? '';
  if (host.startsWith('www.')) host = host.substring(4);
  return host.isEmpty ? 'a page' : host;
}

String _links(String text) {
  // Images first: say there is one, by its alt text when it has any.
  text = text.replaceAllMapped(RegExp(r'!\[([^\]]*)\]\([^)]*\)'), (m) {
    final alt = m.group(1)!.trim();
    return alt.isEmpty ? 'an image' : 'an image, $alt';
  });
  text = text.replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]*\)'), (m) => m.group(1)!);
  text = text.replaceAllMapped(RegExp(r'<(https?://[^>\s]+)>'), (m) => 'a link to ${_host(m.group(1)!)}');
  return text.replaceAllMapped(
    RegExp(r'https?://[^\s)>\]]+'),
    (m) => 'a link to ${_host(m.group(0)!.replaceFirst(RegExp(r'[.,;:!?]+$'), ''))}',
  );
}

String _inlineCode(String text) => text.replaceAllMapped(RegExp(r'`+([^`\n]+?)`+'), (m) => m.group(1)!);

String _paths(String text) {
  // A path: two or more slash-joined segments, or a rooted/home path; its
  // basename is what anyone would say.
  final path = RegExp(r'(?<![\w/.:])(?:~|\.{1,2})?/?(?:[\w.@+-]+/)+([\w.@+-]+)(?![\w/])');
  return text.replaceAllMapped(path, (m) {
    final whole = m.group(0)!;
    final base = m.group(1)!;
    // "and/or", "client/server": plain words, not a path.
    final plainWords = !whole.contains('.') && !whole.startsWith('/') && !whole.startsWith('~') && '/'.allMatches(whole).length == 1;
    return plainWords ? whole : base;
  });
}

String _identifiers(String text) {
  // snake_case (and SCREAMING_CASE) words: underscores become spaces.
  text = text.replaceAllMapped(
    RegExp(r'\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b'),
    (m) => m.group(0)!.split('_').join(' '),
  );
  // camelCase and PascalCase: a space at each lower-to-upper step.
  return text.replaceAllMapped(
    RegExp(r'\b[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b'),
    (m) => m.group(0)!.replaceAllMapped(RegExp(r'([a-z0-9])([A-Z])'), (x) => '${x.group(1)} ${x.group(2)}'),
  );
}

String _stripMarkdown(String text) {
  final lines = <String>[];
  for (var line in text.split('\n')) {
    line = line
        .replaceFirst(RegExp(r'^\s{0,3}#{1,6}\s+'), '')
        .replaceFirst(RegExp(r'^\s*>\s?'), '')
        .replaceFirst(RegExp(r'^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?'), '');
    if (RegExp(r'^\s*([-*_])(\s*\1){2,}\s*$').hasMatch(line)) continue; // a rule
    line = line
        .replaceAllMapped(RegExp(r'(\*\*|__)(.+?)\1'), (m) => m.group(2)!)
        .replaceAllMapped(RegExp(r'(?<![\w*])\*(?!\s)([^*\n]+?)\*(?!\w)'), (m) => m.group(1)!)
        .replaceAllMapped(RegExp(r'(?<!\w)_(?!\s)([^_\n]+?)_(?!\w)'), (m) => m.group(1)!)
        .replaceAllMapped(RegExp(r'~~(.+?)~~'), (m) => m.group(1)!)
        .replaceAll(RegExp(r'<[^>\n]+>'), '')
        .replaceAll(RegExp(r'[ \t]+'), ' ')
        .trim();
    if (line.isEmpty) continue;
    // A heading or list item is its own sentence when spoken.
    if (!RegExp(r'[.!?:;,…]$').hasMatch(line)) line = '$line.';
    lines.add(line);
  }
  return lines.join(' ');
}

String _cut(String text) {
  if (text.length <= speechLimit) return text;
  final head = text.substring(0, speechLimit + 1);
  final ends = RegExp(r'[.!?…](?=\s)').allMatches(head).toList();
  String kept;
  if (ends.isNotEmpty && ends.last.end >= speechLimit ~/ 3) {
    kept = text.substring(0, ends.last.end);
  } else {
    final space = head.lastIndexOf(' ');
    kept = '${text.substring(0, space > 0 ? space : speechLimit).replaceFirst(RegExp(r'[,;:\s]+$'), '')}.';
  }
  return '$kept $moreOnScreen';
}
