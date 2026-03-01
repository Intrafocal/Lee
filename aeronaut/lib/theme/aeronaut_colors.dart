import 'package:flutter/material.dart';

/// Aeronaut's color palette - terminal-inspired dark theme
///
/// GitHub dark style backgrounds with terminal green accents.
/// Terminal-inspired dark theme for the IDE companion.
class AeronautColors {
  AeronautColors._();

  // Backgrounds - Near-black grays (GitHub dark)
  static const bgPrimary = Color(0xFF0D1117);
  static const bgSurface = Color(0xFF161B22);
  static const bgElevated = Color(0xFF21262D);
  static const bgInput = Color(0xFF0D1117);

  // Text
  static const textPrimary = Color(0xFFE6EDF3);
  static const textSecondary = Color(0xFF8B949E);
  static const textTertiary = Color(0xFF484F58);

  // Status
  static const online = Color(0xFF3FB950); // Terminal green
  static const offline = Color(0xFFDA3633); // Red
  static const warning = Color(0xFFD29922); // Amber
  static const info = Color(0xFF58A6FF); // Blue

  // Accent - terminal green
  static const accent = Color(0xFF3FB950);
  static const accentMuted = Color(0xFF238636);

  // Borders
  static const border = Color(0xFF30363D);
  static const borderFocused = Color(0xFF58A6FF);

  // Divider
  static Color get divider => Colors.white.withValues(alpha: 0.08);

  // Overlays
  static Color get overlay => Colors.black.withValues(alpha: 0.5);
}
