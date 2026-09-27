import 'package:flutter/material.dart';

import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_tokens.dart';

/// Phone versions of the Cockpit primitives (cockpit design §1.3), so Work,
/// the one-agent screen and Library share one look. The rules (§0):
/// phosphor marks the one next step (at most one [NextButton] per view),
/// ember is a dot and only means "needs you", and your own words are in
/// Newsreader ([writingStyle]).

/// Newsreader, for anything you wrote (§0 rule 3).
TextStyle writingStyle({double size = 17, bool italic = false, Color color = Phosphor.text1}) => TextStyle(
      fontFamily: Phosphor.fontWrite,
      fontFamilyFallback: Phosphor.fontWriteFallback,
      fontSize: size,
      height: 1.4,
      fontStyle: italic ? FontStyle.italic : FontStyle.normal,
      color: color,
    );

enum DotKind { needs, working, done, idle }

/// A 7px state dot: ember (needs you), phosphor (working), a text-2 ring
/// (done), text-3 (idle).
class WorkDot extends StatelessWidget {
  final DotKind kind;

  const WorkDot(this.kind, {super.key});

  @override
  Widget build(BuildContext context) {
    final (Color? fill, Color? ring) = switch (kind) {
      DotKind.needs => (Phosphor.ember, null),
      DotKind.working => (Phosphor.phosphor, null),
      DotKind.done => (null, Phosphor.text2),
      DotKind.idle => (Phosphor.text3, null),
    };
    return Container(
      key: ValueKey('dot-${kind.name}'),
      width: 7,
      height: 7,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: fill,
        border: ring == null ? null : Border.all(color: ring),
      ),
    );
  }
}

/// 12px uppercase label over a group ("WAITING ON YOU", "IN FLIGHT").
class Eyebrow extends StatelessWidget {
  final String text;
  final bool needs;

  const Eyebrow(this.text, {this.needs = false, super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AeronautTheme.spacingMd,
        AeronautTheme.spacingLg,
        AeronautTheme.spacingMd,
        AeronautTheme.spacingSm,
      ),
      child: Text(
        text.toUpperCase(),
        style: TextStyle(
          fontSize: 12,
          letterSpacing: 0.72,
          fontWeight: FontWeight.w500,
          color: needs ? Phosphor.ember : Phosphor.text3,
        ),
      ),
    );
  }
}

/// A rounded card: plain (ground-2 fill, ground-4 hairline) or raised
/// (ground-3 fill, ground-5 border) for the one item that needs you most.
class WorkCard extends StatelessWidget {
  final Widget child;
  final bool raised;
  final VoidCallback? onOpen;
  final EdgeInsetsGeometry padding;

  const WorkCard({
    required this.child,
    this.raised = false,
    this.onOpen,
    this.padding = const EdgeInsets.all(AeronautTheme.spacingMd),
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(AeronautTheme.radiusMd);
    return Material(
      color: raised ? Phosphor.ground3 : Phosphor.ground2,
      shape: RoundedRectangleBorder(
        borderRadius: radius,
        side: BorderSide(color: raised ? Phosphor.ground5 : Phosphor.ground4),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onOpen,
        child: Padding(padding: padding, child: child),
      ),
    );
  }
}

/// A pill chip for a quick reply: ground-3 fill, ground-4 border, 13px.
class QuickChip extends StatelessWidget {
  final String label;
  final VoidCallback? onTap;

  const QuickChip({required this.label, this.onTap, super.key});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Phosphor.ground3,
      shape: const StadiumBorder(side: BorderSide(color: Phosphor.ground4)),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 36),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            child: Text(
              label,
              style: TextStyle(fontSize: 13, color: onTap == null ? Phosphor.text3 : Phosphor.text1),
            ),
          ),
        ),
      ),
    );
  }
}

enum BtnKind { next, plain, quiet }

/// A button in one of the three kinds: `next` (phosphor fill, at most one
/// per view), `plain` (ground-4 fill) or `quiet` (text only).
class WorkButton extends StatelessWidget {
  final String label;
  final BtnKind kind;
  final VoidCallback? onPressed;
  final double height;
  final bool busy;

  const WorkButton({
    required this.label,
    this.kind = BtnKind.plain,
    this.onPressed,
    this.height = 44,
    this.busy = false,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !busy;
    final (Color bg, Color fg) = switch (kind) {
      BtnKind.next => (Phosphor.phosphor, Phosphor.onPhosphor),
      BtnKind.plain => (Phosphor.ground4, Phosphor.text1),
      BtnKind.quiet => (Colors.transparent, Phosphor.text2),
    };
    final child = busy
        ? SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2, color: fg),
          )
        : Text(
            label,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500, color: enabled ? fg : fg.withValues(alpha: 0.5)),
          );
    return SizedBox(
      height: height,
      child: Material(
        color: enabled || kind == BtnKind.quiet ? bg : Phosphor.ground5,
        borderRadius: BorderRadius.circular(AeronautTheme.radiusSm),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: enabled ? onPressed : null,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
            child: Center(widthFactor: 1, child: child),
          ),
        ),
      ),
    );
  }
}

/// Your words, quoted: Newsreader italic with curly quotes (§1.3 WritingQuote).
class WritingQuote extends StatelessWidget {
  final String text;
  final double size;
  final int? maxLines;

  const WritingQuote(this.text, {this.size = 18, this.maxLines, super.key});

  @override
  Widget build(BuildContext context) {
    return Text(
      '“${text.trim()}”',
      maxLines: maxLines,
      overflow: maxLines == null ? null : TextOverflow.ellipsis,
      style: writingStyle(size: size, italic: true, color: Phosphor.text2),
    );
  }
}

/// A 13px neutral line under a heading.
class QuietText extends StatelessWidget {
  final String text;

  const QuietText(this.text, {super.key});

  @override
  Widget build(BuildContext context) {
    return Text(text, style: AeronautTheme.footnote.copyWith(color: AeronautColors.textTertiary));
  }
}
