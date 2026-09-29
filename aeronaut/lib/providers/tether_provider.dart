import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../models/machine.dart';
import '../models/send_to_lee.dart';
import '../models/tether.dart';
import '../screens/scribble_screen.dart';
import '../services/tether_api.dart';
import 'machines_provider.dart';
import 'windows_provider.dart';

/// How a [TetherApi] is built for a call; tests override it with a fake
/// client. Like every `*_api.dart`, it's constructed per call and disposed.
final tetherApiFactoryProvider = Provider<TetherApi Function(Machine machine)>((ref) => (m) => TetherApi(machine: m));

/// Where a card (a Page or a Board) opened from Work's Pick up goes: Review listens and opens
/// it on its own stack (docs/plans/2026-09-28-tether-review-voice.md §3.1).
class PageRequest {
  final String cardId;
  final String title;

  const PageRequest(this.cardId, this.title);
}

final reviewPageRequestProvider = StateProvider<PageRequest?>((ref) => null);

/// Work's Pick up: `GET /tether` for the selected window's workspace.
/// Work's pull-to-refresh invalidates it.
final tetherProvider = FutureProvider.autoDispose<TetherResult>((ref) async {
  final machine = ref.watch(machinesProvider.select((s) => s.activeMachine));
  final workspace = ref.watch(windowsProvider.select((s) => s.activeWindow?.workspace));
  if (machine == null) return const TetherResult(error: 'No machine selected.');
  final api = ref.read(tetherApiFactoryProvider)(machine);
  try {
    return await api.getTether(workspace: workspace);
  } finally {
    api.dispose();
  }
});

/// Picks an image for Send to Lee: Photo (the camera), Screenshot (the
/// photo library) or Scribble (a canvas). Null when you back out. Tests
/// override it.
typedef ImagePick = Future<ImageItem?> Function(BuildContext context, ImageSourceKind kind);

final imagePickProvider = Provider<ImagePick>((ref) => pickSendImage);

Future<ImageItem?> pickSendImage(BuildContext context, ImageSourceKind kind) async {
  if (kind == ImageSourceKind.scribble) {
    final png = await Navigator.of(context).push(
      MaterialPageRoute<ScribbleResult>(fullscreenDialog: true, builder: (_) => const ScribbleScreen()),
    );
    return png == null ? null : ImageItem(mime: 'image/png', bytes: png.png, source: ImageSourceKind.scribble);
  }
  final file = await ImagePicker().pickImage(
    source: kind == ImageSourceKind.photo ? ImageSource.camera : ImageSource.gallery,
    // Re-encoded as JPEG (iOS converts HEIC) and kept well under the 10 MB cap.
    maxWidth: 2560,
    maxHeight: 2560,
    imageQuality: 85,
    requestFullMetadata: false,
  );
  if (file == null) return null;
  final bytes = await file.readAsBytes();
  final png = (file.mimeType ?? '').contains('png') || file.name.toLowerCase().endsWith('.png');
  return ImageItem(mime: png ? 'image/png' : 'image/jpeg', bytes: bytes, source: kind);
}
