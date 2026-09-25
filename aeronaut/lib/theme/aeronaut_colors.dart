import 'phosphor_tokens.dart';

/// Aeronaut's color palette — re-pointed at the Phosphor design tokens
/// (`theme/phosphor_tokens.dart`, generated from `design/tokens.json`).
///
/// This keeps the original `AeronautColors` API (so every call site across
/// the app keeps compiling unchanged) while the actual values now come from
/// Phosphor. Mapping notes, since several old names had no 1:1 Phosphor
/// token:
/// - [chrome] (new) is `ground1` — title/tab/status/nav bar backgrounds.
/// - [bgPrimary] is `ground2` — the main content/scaffold background, one
///   step lighter than chrome so screens read as "inside" the chrome frame.
/// - [bgSurface] / [bgInput] are both `ground3` — cards, sheets, list rows,
///   and input fills all sit on the same "raised" plane.
/// - [bgElevated] is `ground5` — popups, active/selected chips, badges: the
///   most raised, highest-contrast surface short of a border.
/// - [onAccent] (new) is `onPhosphor` — text/icons drawn on a phosphor fill
///   (primary buttons, active badges).
class AeronautColors {
  AeronautColors._();

  // Backgrounds
  static const chrome = Phosphor.ground1;
  static const bgPrimary = Phosphor.ground2;
  static const bgSurface = Phosphor.ground3;
  static const bgElevated = Phosphor.ground5;
  static const bgInput = Phosphor.ground3;

  // Text
  static const textPrimary = Phosphor.text1;
  static const textSecondary = Phosphor.text2;
  static const textTertiary = Phosphor.text3;

  // Status
  static const online = Phosphor.phosphor;
  static const offline = Phosphor.error;
  static const warning = Phosphor.ember;
  static const info = Phosphor.info;

  // Accent — phosphor brand green
  static const accent = Phosphor.phosphor;
  static const accentMuted = Phosphor.phosphorDeep;
  static const onAccent = Phosphor.onPhosphor;

  // Borders
  static const border = Phosphor.ground4;
  static const borderFocused = Phosphor.lit;

  // Divider
  static const divider = Phosphor.ground4;

  // Overlays
  static const overlay = Phosphor.overlay;
}
