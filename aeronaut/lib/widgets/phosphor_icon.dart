import 'package:flutter/widgets.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../theme/aeronaut_colors.dart';
import '../theme/phosphor_icons.generated.dart';

/// Renders a [PhosphorIconData] SVG, recoloring it via [ColorFilter] the
/// same way `Icon` recolors a glyph.
///
/// Stroke icons (the default set) are drawn `stroke-width="1.75"`; at
/// `size <= 18` that reads thin, so this bumps it to 2 for small renders.
/// The `hester` mark is a filled silhouette with a non-square aspect ratio
/// (520:710) — its width is scaled from [size] to preserve it rather than
/// being forced into a square box.
class PhosphorIcon extends StatelessWidget {
  final PhosphorIconData icon;
  final double size;
  final Color? color;
  final String? semanticLabel;

  const PhosphorIcon(
    this.icon, {
    this.size = 24,
    this.color,
    this.semanticLabel,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    final iconColor = color ?? IconTheme.of(context).color ?? AeronautColors.textPrimary;
    var svg = icon.svg;
    if (!icon.filled && size <= 18) {
      svg = svg.replaceFirst('stroke-width="1.75"', 'stroke-width="2"');
    }
    final width = icon.name == 'hester' ? size * 520 / 710 : size;
    return SvgPicture.string(
      svg,
      width: width,
      height: size,
      colorFilter: ColorFilter.mode(iconColor, BlendMode.srcIn),
      semanticsLabel: semanticLabel,
    );
  }
}
