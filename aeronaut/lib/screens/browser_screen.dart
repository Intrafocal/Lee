import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers/browser_cast_provider.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';

/// Remote browser tab that renders Lee's browser via CDP screencast.
///
/// Displays JPEG frames streamed from Lee and forwards touch/key events.
/// Works on real phones — rendering happens on the Mac, not locally.
class BrowserScreen extends ConsumerStatefulWidget {
  final int tabId;

  const BrowserScreen({required this.tabId, super.key});

  @override
  ConsumerState<BrowserScreen> createState() => _BrowserScreenState();
}

class _BrowserScreenState extends ConsumerState<BrowserScreen>
    with WidgetsBindingObserver {
  final TextEditingController _urlController = TextEditingController();
  final FocusNode _urlFocus = FocusNode();
  final GlobalKey _imageKey = GlobalKey();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _urlController.dispose();
    _urlFocus.dispose();
    super.dispose();
  }

  @override
  void didChangeMetrics() {
    _sendResize();
  }

  void _sendInit() {
    final notifier = ref.read(browserCastProvider(widget.tabId).notifier);
    if (notifier.initSent) return;
    final mq = MediaQuery.of(context);
    final size = mq.size;
    final ratio = mq.devicePixelRatio;
    final orientation =
        size.width > size.height ? 'landscape' : 'portrait';

    notifier.sendInit(
          width: size.width,
          height: size.height - 50,
          pixelRatio: ratio,
          orientation: orientation,
        );
  }

  void _sendResize() {
    if (!ref.read(browserCastProvider(widget.tabId).notifier).initSent) return;
    final mq = MediaQuery.of(context);
    final size = mq.size;
    final ratio = mq.devicePixelRatio;
    final orientation =
        size.width > size.height ? 'landscape' : 'portrait';

    ref.read(browserCastProvider(widget.tabId).notifier).sendResize(
          width: size.width,
          height: size.height - 50,
          pixelRatio: ratio,
          orientation: orientation,
        );
  }

  void _onTap(TapUpDetails details) {
    final normalized = _normalizePosition(details.localPosition);
    if (normalized != null) {
      ref
          .read(browserCastProvider(widget.tabId).notifier)
          .sendTap(normalized.dx, normalized.dy);
    }
  }

  Offset? _normalizePosition(Offset local) {
    final renderBox =
        _imageKey.currentContext?.findRenderObject() as RenderBox?;
    if (renderBox == null) return null;
    final size = renderBox.size;
    if (size.width == 0 || size.height == 0) return null;
    return Offset(
      (local.dx / size.width).clamp(0.0, 1.0),
      (local.dy / size.height).clamp(0.0, 1.0),
    );
  }

  void _navigate() {
    var url = _urlController.text.trim();
    if (url.isEmpty) return;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'http://$url';
    }
    ref.read(browserCastProvider(widget.tabId).notifier).sendNavigate(url);
    _urlFocus.unfocus();
  }

  @override
  Widget build(BuildContext context) {
    final castState = ref.watch(browserCastProvider(widget.tabId));

    // Send init once connected (resets on reconnect)
    final notifier = ref.read(browserCastProvider(widget.tabId).notifier);
    if (castState.isConnected && !notifier.initSent) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _sendInit());
    }

    // Update URL bar from metadata
    if (castState.metadata.url.isNotEmpty &&
        !_urlFocus.hasFocus &&
        _urlController.text != castState.metadata.url) {
      _urlController.text = castState.metadata.url;
    }

    return Column(
      children: [
        // Navigation bar
        Container(
          padding: const EdgeInsets.symmetric(
            horizontal: AeronautTheme.spacingSm,
            vertical: AeronautTheme.spacingXs,
          ),
          color: AeronautColors.bgSurface,
          child: Row(
            children: [
              // Connection indicator
              Container(
                width: 8,
                height: 8,
                margin: const EdgeInsets.only(right: 8),
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: castState.isConnected
                      ? AeronautColors.online
                      : AeronautColors.offline,
                ),
              ),
              // URL bar
              Expanded(
                child: Container(
                  height: 32,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  decoration: BoxDecoration(
                    color: AeronautColors.bgPrimary,
                    borderRadius:
                        BorderRadius.circular(AeronautTheme.radiusSm),
                    border: Border.all(color: AeronautColors.border),
                  ),
                  child: Row(
                    children: [
                      const Icon(
                        Icons.cast_connected,
                        size: 14,
                        color: AeronautColors.accent,
                      ),
                      const SizedBox(width: 4),
                      Expanded(
                        child: TextField(
                          controller: _urlController,
                          focusNode: _urlFocus,
                          onSubmitted: (_) => _navigate(),
                          style: AeronautTheme.mono.copyWith(
                            fontSize: 12,
                            color: AeronautColors.textSecondary,
                          ),
                          decoration: const InputDecoration(
                            border: InputBorder.none,
                            contentPadding: EdgeInsets.zero,
                            isDense: true,
                            hintText: 'Enter URL...',
                            hintStyle: TextStyle(
                              color: AeronautColors.textTertiary,
                              fontSize: 12,
                            ),
                          ),
                          textInputAction: TextInputAction.go,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        // Content area
        Expanded(
          child: _buildContent(castState),
        ),
      ],
    );
  }

  Widget _buildContent(BrowserCastState castState) {
    if (castState.hasError && castState.frame == null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(
              Icons.error_outline,
              size: 48,
              color: AeronautColors.offline,
            ),
            const SizedBox(height: AeronautTheme.spacingMd),
            Text(
              castState.errorMessage ?? 'Connection failed',
              textAlign: TextAlign.center,
              style: AeronautTheme.body.copyWith(
                color: AeronautColors.textSecondary,
              ),
            ),
          ],
        ),
      );
    }

    if (castState.frame == null) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            CircularProgressIndicator(
              color: AeronautColors.accent,
              strokeWidth: 2,
            ),
            SizedBox(height: AeronautTheme.spacingMd),
            Text(
              'Connecting to browser...',
              style: TextStyle(color: AeronautColors.textSecondary),
            ),
          ],
        ),
      );
    }

    return GestureDetector(
      onTapUp: _onTap,
      onVerticalDragUpdate: (details) {
        final normalized = _normalizePosition(details.localPosition);
        if (normalized != null) {
          ref.read(browserCastProvider(widget.tabId).notifier).sendScroll(
                normalized.dx,
                normalized.dy,
                0,
                -details.delta.dy * 3,
              );
        }
      },
      child: Image.memory(
        castState.frame!,
        key: _imageKey,
        fit: BoxFit.fitWidth,
        gaplessPlayback: true,
        width: double.infinity,
      ),
    );
  }
}
