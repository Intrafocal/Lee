import 'package:flutter_test/flutter_test.dart';
import 'package:aeronaut/models/fs_entry.dart';

void main() {
  group('classifyFile', () {
    test('markdown extensions', () {
      expect(classifyFile('README.md'), FileViewKind.markdown);
      expect(classifyFile('/a/b/notes.markdown'), FileViewKind.markdown);
    });

    test('image extensions', () {
      for (final ext in ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']) {
        expect(classifyFile('pic.$ext'), FileViewKind.image, reason: ext);
      }
    });

    test('pdf', () {
      expect(classifyFile('doc.pdf'), FileViewKind.pdf);
    });

    test('code extensions', () {
      for (final ext in ['dart', 'ts', 'py', 'go', 'rs', 'json', 'yaml']) {
        expect(classifyFile('main.$ext'), FileViewKind.code, reason: ext);
      }
    });

    test('unknown or missing extension falls back to text', () {
      expect(classifyFile('Makefile'), FileViewKind.text);
      expect(classifyFile('archive.step'), FileViewKind.text);
      expect(classifyFile('data.bin'), FileViewKind.text);
    });

    test('is case-insensitive', () {
      expect(classifyFile('README.MD'), FileViewKind.markdown);
      expect(classifyFile('Photo.PNG'), FileViewKind.image);
    });
  });

  group('FsReadResult', () {
    test('parses a utf8 text response', () {
      final result = FsReadResult.fromJson({
        'path': '/ws/main.py',
        'size': 42,
        'mtimeMs': 1700000000000,
        'mime': 'text/x-python',
        'encoding': 'utf8',
        'content': 'print("hi")\n',
      });

      expect(result.path, '/ws/main.py');
      expect(result.size, 42);
      expect(result.mime, 'text/x-python');
      expect(result.isUtf8, isTrue);
      expect(result.isBase64, isFalse);
      expect(result.content, 'print("hi")\n');
      expect(result.mtime.millisecondsSinceEpoch, 1700000000000);
    });

    test('parses a base64 image response', () {
      final result = FsReadResult.fromJson({
        'path': '/ws/logo.png',
        'size': 1024,
        'mtimeMs': 1700000000000,
        'mime': 'image/png',
        'encoding': 'base64',
        'content': 'iVBORw0KGgo=',
      });

      expect(result.isBase64, isTrue);
      expect(result.isUtf8, isFalse);
    });

    test('parses a stat-only response with no content', () {
      final result = FsReadResult.fromJson({
        'path': '/ws/model.step',
        'size': 5000000,
        'mtimeMs': 1700000000000,
        'mime': 'model/step',
      });

      expect(result.content, isNull);
      expect(result.encoding, isNull);
      expect(result.size, 5000000);
    });

    test('missing fields fall back to safe defaults', () {
      final result = FsReadResult.fromJson({});
      expect(result.path, '');
      expect(result.size, 0);
      expect(result.mime, 'application/octet-stream');
      expect(result.content, isNull);
    });
  });

  group('FsEntryInfo', () {
    test('parses a directory entry', () {
      final entry = FsEntryInfo.fromJson({
        'name': 'src',
        'type': 'dir',
        'size': 0,
        'mtimeMs': 1700000000000,
      });
      expect(entry.isDir, isTrue);
      expect(entry.isSymlink, isFalse);
    });

    test('parses a symlink entry', () {
      final entry = FsEntryInfo.fromJson({
        'name': 'link',
        'type': 'symlink',
        'size': 12,
        'mtimeMs': 1700000000000,
      });
      expect(entry.isSymlink, isTrue);
      expect(entry.isDir, isFalse);
    });
  });

  group('FsListResult', () {
    test('parses a directory listing', () {
      final result = FsListResult.fromJson({
        'path': '/ws',
        'entries': [
          {'name': 'src', 'type': 'dir', 'size': 0, 'mtimeMs': 1},
          {'name': 'README.md', 'type': 'file', 'size': 200, 'mtimeMs': 2},
        ],
      });

      expect(result.path, '/ws');
      expect(result.entries.length, 2);
      expect(result.entries[0].name, 'src');
      expect(result.entries[1].type, 'file');
    });

    test('missing entries list parses as empty', () {
      final result = FsListResult.fromJson({'path': '/ws'});
      expect(result.entries, isEmpty);
    });
  });
}
