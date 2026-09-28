import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../theme/phosphor_tokens.dart';
import '../widgets/work_ui.dart';

/// A finished scribble, as PNG bytes.
class ScribbleResult {
  final Uint8List png;

  const ScribbleResult(this.png);
}

/// Scribble for Send to Lee (docs/plans/2026-09-28-tether-review-voice.md
/// §4.5): a full-screen canvas for finger strokes, with Undo and Clear;
/// Use exports it as a PNG, ink on the app's ground.
class ScribbleScreen extends StatefulWidget {
  const ScribbleScreen({super.key});

  @override
  State<ScribbleScreen> createState() => _ScribbleScreenState();
}

class _ScribbleScreenState extends State<ScribbleScreen> {
  final List<List<Offset>> _strokes = [];
  Size _size = Size.zero;
  bool _exporting = false;

  static const _ink = Phosphor.text1;
  static const _paper = Phosphor.ground1;
  static const _width = 3.0;

  Future<void> _use() async {
    if (_strokes.isEmpty || _exporting || _size.isEmpty) return;
    setState(() => _exporting = true);
    final navigator = Navigator.of(context);
    final ratio = MediaQuery.of(context).devicePixelRatio.clamp(1.0, 2.0);
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder)..scale(ratio);
    paintScribble(canvas, _size, _strokes);
    final image = await recorder.endRecording().toImage((_size.width * ratio).round(), (_size.height * ratio).round());
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    if (!mounted) return;
    setState(() => _exporting = false);
    if (data != null) navigator.pop(ScribbleResult(data.buffer.asUint8List()));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _paper,
      appBar: AppBar(
        title: const Text('Scribble'),
        actions: [
          TextButton(
            key: const ValueKey('scribble-undo'),
            onPressed: _strokes.isEmpty ? null : () => setState(_strokes.removeLast),
            child: const Text('Undo'),
          ),
          TextButton(
            key: const ValueKey('scribble-clear'),
            onPressed: _strokes.isEmpty ? null : () => setState(_strokes.clear),
            child: const Text('Clear'),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  _size = constraints.biggest;
                  return GestureDetector(
                    key: const ValueKey('scribble-canvas'),
                    onPanStart: (d) => setState(() => _strokes.add([d.localPosition])),
                    onPanUpdate: (d) => setState(() => _strokes.last.add(d.localPosition)),
                    child: CustomPaint(
                      size: constraints.biggest,
                      painter: _ScribblePainter(_strokes, _strokes.fold(0, (n, s) => n + s.length)),
                    ),
                  );
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: SizedBox(
                width: double.infinity,
                child: WorkButton(
                  key: const ValueKey('scribble-use'),
                  label: 'Use this scribble',
                  kind: BtnKind.next,
                  height: 48,
                  busy: _exporting,
                  onPressed: _strokes.isEmpty ? null : _use,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Paper, then each stroke as a round-capped path (a dot for a tap).
void paintScribble(Canvas canvas, Size size, List<List<Offset>> strokes) {
  canvas.drawRect(Offset.zero & size, Paint()..color = _ScribbleScreenState._paper);
  final pen = Paint()
    ..color = _ScribbleScreenState._ink
    ..strokeWidth = _ScribbleScreenState._width
    ..strokeCap = StrokeCap.round
    ..strokeJoin = StrokeJoin.round
    ..style = PaintingStyle.stroke;
  for (final stroke in strokes) {
    if (stroke.length == 1) {
      canvas.drawCircle(stroke.first, _ScribbleScreenState._width / 2, Paint()..color = _ScribbleScreenState._ink);
      continue;
    }
    final path = Path()..moveTo(stroke.first.dx, stroke.first.dy);
    for (final p in stroke.skip(1)) {
      path.lineTo(p.dx, p.dy);
    }
    canvas.drawPath(path, pen);
  }
}

class _ScribblePainter extends CustomPainter {
  final List<List<Offset>> strokes;

  /// Changes whenever a point is added, so the painter repaints.
  final int points;

  _ScribblePainter(this.strokes, this.points);

  @override
  void paint(Canvas canvas, Size size) => paintScribble(canvas, size, strokes);

  @override
  bool shouldRepaint(covariant _ScribblePainter old) => old.points != points || old.strokes.length != strokes.length;
}
