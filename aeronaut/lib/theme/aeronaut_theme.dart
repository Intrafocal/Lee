import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import 'aeronaut_colors.dart';
import 'phosphor_tokens.dart';

/// Aeronaut's Material 3 dark theme — terminal-inspired, built on the
/// Phosphor design tokens (see `aeronaut_colors.dart`, `phosphor_tokens.dart`).
class AeronautTheme {
  AeronautTheme._();

  static const _fontFamily = 'SF Pro Text';
  static const monoFontFamily = 'JetBrainsMono';

  // Spacing
  static const double spacingXs = 4.0;
  static const double spacingSm = 8.0;
  static const double spacingMd = 16.0;
  static const double spacingLg = 24.0;
  static const double spacingXl = 32.0;

  // Radius
  static const double radiusSm = 6.0;
  static const double radiusMd = 10.0;
  static const double radiusLg = 14.0;

  // Text styles — named by iOS Dynamic Type role, not by size, so call
  // sites read intent ("this is a headline") instead of a magic number.
  // UI stays on the system font (SF); mono is JetBrains Mono at a fixed 13.
  static const caption2 = TextStyle(
    fontFamily: _fontFamily,
    fontWeight: FontWeight.w400,
    fontSize: 11,
    color: AeronautColors.textSecondary,
  );

  static const caption1 = TextStyle(
    fontFamily: _fontFamily,
    fontWeight: FontWeight.w400,
    fontSize: 12,
    color: AeronautColors.textSecondary,
  );

  static const footnote = TextStyle(
    fontFamily: _fontFamily,
    fontWeight: FontWeight.w400,
    fontSize: 13,
    color: AeronautColors.textSecondary,
  );

  static const subheadline = TextStyle(
    fontFamily: _fontFamily,
    fontWeight: FontWeight.w400,
    fontSize: 15,
    color: AeronautColors.textPrimary,
    height: 1.4,
  );

  /// Primary reading text — chat messages, prose. Not every list-row label;
  /// use [subheadline] for compact UI text.
  static const body = TextStyle(
    fontFamily: _fontFamily,
    fontWeight: FontWeight.w400,
    fontSize: 17,
    color: AeronautColors.textPrimary,
    height: 1.4,
  );

  static const headline = TextStyle(
    fontFamily: _fontFamily,
    fontWeight: FontWeight.w600,
    fontSize: 17,
    color: AeronautColors.textPrimary,
  );

  static const title3 = TextStyle(
    fontFamily: _fontFamily,
    fontWeight: FontWeight.w600,
    fontSize: 20,
    color: AeronautColors.textPrimary,
    letterSpacing: -0.2,
  );

  static const title2 = TextStyle(
    fontFamily: _fontFamily,
    fontWeight: FontWeight.w600,
    fontSize: 22,
    color: AeronautColors.textPrimary,
    letterSpacing: -0.2,
  );

  static const largeTitle = TextStyle(
    fontFamily: _fontFamily,
    fontWeight: FontWeight.w700,
    fontSize: 34,
    color: AeronautColors.textPrimary,
    letterSpacing: -0.4,
  );

  static const mono = TextStyle(
    fontFamily: monoFontFamily,
    fontWeight: FontWeight.w400,
    fontSize: 13,
    color: AeronautColors.textPrimary,
    height: 1.5,
  );

  static ThemeData get darkTheme {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,

      colorScheme: const ColorScheme.dark(
        primary: AeronautColors.accent,
        onPrimary: AeronautColors.onAccent,
        secondary: AeronautColors.info,
        onSecondary: AeronautColors.textPrimary,
        error: AeronautColors.offline,
        onError: AeronautColors.textPrimary,
        surface: AeronautColors.bgSurface,
        onSurface: AeronautColors.textPrimary,
      ),

      scaffoldBackgroundColor: AeronautColors.bgPrimary,

      // iOS navigation: slide transitions with edge-swipe back for every
      // pushed route, and Cupertino widgets (nav bars, tab bar, action
      // sheets, .adaptive indicators) tinted with the Phosphor palette.
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
          TargetPlatform.android: CupertinoPageTransitionsBuilder(),
          TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
        },
      ),
      cupertinoOverrideTheme: const CupertinoThemeData(
        brightness: Brightness.dark,
        primaryColor: AeronautColors.accent,
        primaryContrastingColor: AeronautColors.onAccent,
        barBackgroundColor: AeronautColors.chrome,
        scaffoldBackgroundColor: AeronautColors.bgPrimary,
        textTheme: CupertinoTextThemeData(
          primaryColor: AeronautColors.accent,
          textStyle: TextStyle(color: AeronautColors.textPrimary, fontSize: 17),
          navTitleTextStyle: TextStyle(
            color: AeronautColors.textPrimary,
            fontSize: 17,
            fontWeight: FontWeight.w600,
          ),
          navLargeTitleTextStyle: TextStyle(
            color: AeronautColors.textPrimary,
            fontSize: 34,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.4,
          ),
          tabLabelTextStyle: TextStyle(fontSize: 10, letterSpacing: -0.1),
        ),
      ),

      appBarTheme: const AppBarTheme(
        backgroundColor: AeronautColors.chrome,
        foregroundColor: AeronautColors.textPrimary,
        elevation: 0,
        centerTitle: true,
        scrolledUnderElevation: 0,
        titleTextStyle: headline,
        systemOverlayStyle: SystemUiOverlayStyle(
          statusBarColor: Colors.transparent,
          statusBarIconBrightness: Brightness.light,
          statusBarBrightness: Brightness.dark,
        ),
      ),

      cardTheme: CardThemeData(
        color: AeronautColors.bgSurface,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusMd),
          side: const BorderSide(color: AeronautColors.border),
        ),
        margin: EdgeInsets.zero,
      ),

      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AeronautColors.accent,
          foregroundColor: AeronautColors.onAccent,
          disabledBackgroundColor: AeronautColors.bgElevated,
          disabledForegroundColor: AeronautColors.textTertiary,
          elevation: 0,
          textStyle: headline,
          padding: const EdgeInsets.symmetric(
            horizontal: spacingLg,
            vertical: spacingSm,
          ),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(radiusSm),
          ),
        ),
      ),

      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AeronautColors.textPrimary,
          disabledForegroundColor: AeronautColors.textTertiary,
          side: const BorderSide(color: AeronautColors.border),
          textStyle: headline,
          padding: const EdgeInsets.symmetric(
            horizontal: spacingLg,
            vertical: spacingSm,
          ),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(radiusSm),
          ),
        ).copyWith(
          overlayColor: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.pressed)
                ? Phosphor.lit.withValues(alpha: 0.12)
                : null,
          ),
        ),
      ),

      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: Phosphor.lit,
          disabledForegroundColor: AeronautColors.textTertiary,
          textStyle: headline,
          padding: const EdgeInsets.symmetric(
            horizontal: spacingSm,
            vertical: spacingXs,
          ),
        ),
      ),

      iconTheme: const IconThemeData(color: AeronautColors.textSecondary),

      expansionTileTheme: const ExpansionTileThemeData(
        iconColor: AeronautColors.textSecondary,
        collapsedIconColor: AeronautColors.textSecondary,
        textColor: AeronautColors.textPrimary,
        collapsedTextColor: AeronautColors.textPrimary,
        backgroundColor: Colors.transparent,
        collapsedBackgroundColor: Colors.transparent,
      ),

      progressIndicatorTheme: const ProgressIndicatorThemeData(
        color: AeronautColors.accent,
        linearTrackColor: AeronautColors.bgElevated,
        circularTrackColor: AeronautColors.bgElevated,
      ),

      chipTheme: ChipThemeData(
        backgroundColor: AeronautColors.bgElevated,
        selectedColor: AeronautColors.accentMuted,
        disabledColor: AeronautColors.bgSurface,
        labelStyle: caption1,
        secondaryLabelStyle: caption1.copyWith(color: AeronautColors.onAccent),
        side: const BorderSide(color: AeronautColors.border),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusSm),
        ),
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AeronautColors.bgInput,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: spacingMd,
          vertical: spacingSm,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusSm),
          borderSide: const BorderSide(color: AeronautColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusSm),
          borderSide: const BorderSide(color: AeronautColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusSm),
          borderSide: const BorderSide(
            color: AeronautColors.borderFocused,
            width: 1.5,
          ),
        ),
        hintStyle: subheadline.copyWith(color: AeronautColors.textTertiary),
        labelStyle: footnote,
      ),

      listTileTheme: const ListTileThemeData(
        contentPadding: EdgeInsets.symmetric(
          horizontal: spacingMd,
          vertical: spacingXs,
        ),
        titleTextStyle: subheadline,
        subtitleTextStyle: caption1,
        iconColor: AeronautColors.textSecondary,
      ),

      dividerTheme: const DividerThemeData(
        color: AeronautColors.divider,
        thickness: 1,
        space: 1,
      ),

      snackBarTheme: SnackBarThemeData(
        backgroundColor: AeronautColors.bgElevated,
        contentTextStyle: subheadline,
        actionTextColor: Phosphor.lit,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusSm),
        ),
        behavior: SnackBarBehavior.floating,
      ),

      floatingActionButtonTheme: const FloatingActionButtonThemeData(
        backgroundColor: AeronautColors.accent,
        foregroundColor: AeronautColors.onAccent,
      ),

      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: AeronautColors.bgSurface,
        selectedItemColor: AeronautColors.accent,
        unselectedItemColor: AeronautColors.textTertiary,
      ),
    );
  }

  /// Shared markdown stylesheet — used by Hester chat, bundle detail, and
  /// the file viewer instead of three separate ad-hoc `MarkdownStyleSheet`s.
  ///
  /// [compact] gives smaller body text (15, `subheadline`) for dense reading
  /// contexts (file viewer, bundle detail); the default (17, `body`) is for
  /// primary reading text like Hester chat.
  static MarkdownStyleSheet markdown(BuildContext context, {bool compact = false}) {
    final p = compact ? subheadline : body;
    return MarkdownStyleSheet(
      p: p,
      h1: title2,
      h2: title3,
      h3: headline,
      strong: p.copyWith(fontWeight: FontWeight.w600),
      em: p.copyWith(fontStyle: FontStyle.italic),
      code: mono.copyWith(
        fontSize: compact ? 13 : 14,
        color: Phosphor.lit,
        backgroundColor: AeronautColors.bgSurface,
      ),
      codeblockDecoration: BoxDecoration(
        color: Phosphor.ground0,
        borderRadius: BorderRadius.circular(radiusMd),
        border: Border.all(color: AeronautColors.border),
      ),
      codeblockPadding: const EdgeInsets.all(spacingSm),
      blockquoteDecoration: const BoxDecoration(
        border: Border(
          left: BorderSide(color: AeronautColors.bgElevated, width: 3),
        ),
      ),
      blockquotePadding: const EdgeInsets.only(left: spacingMd),
      listBullet: p,
      a: TextStyle(
        fontFamily: _fontFamily,
        fontSize: p.fontSize,
        height: p.height,
        color: Phosphor.lit,
        decoration: TextDecoration.underline,
      ),
      tableBorder: TableBorder.all(color: AeronautColors.border),
      tableHead: footnote.copyWith(fontWeight: FontWeight.w600),
      tableBody: footnote,
      horizontalRuleDecoration: const BoxDecoration(
        border: Border(
          top: BorderSide(color: AeronautColors.border),
        ),
      ),
    );
  }
}
