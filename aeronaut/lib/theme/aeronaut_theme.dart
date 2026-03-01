import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'aeronaut_colors.dart';

/// Aeronaut's Material 3 dark theme - terminal-inspired
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

  // Text styles
  static const heading = TextStyle(
    fontFamily: _fontFamily,
    fontWeight: FontWeight.w600,
    fontSize: 18,
    color: AeronautColors.textPrimary,
    letterSpacing: -0.2,
  );

  static const body = TextStyle(
    fontFamily: _fontFamily,
    fontWeight: FontWeight.w400,
    fontSize: 15,
    color: AeronautColors.textPrimary,
    height: 1.5,
  );

  static const caption = TextStyle(
    fontFamily: _fontFamily,
    fontWeight: FontWeight.w400,
    fontSize: 12,
    color: AeronautColors.textSecondary,
  );

  static const mono = TextStyle(
    fontFamily: monoFontFamily,
    fontWeight: FontWeight.w400,
    fontSize: 13,
    color: AeronautColors.textPrimary,
    height: 1.5,
  );

  static const label = TextStyle(
    fontFamily: _fontFamily,
    fontWeight: FontWeight.w500,
    fontSize: 13,
    color: AeronautColors.textSecondary,
  );

  static ThemeData get darkTheme {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,

      colorScheme: const ColorScheme.dark(
        primary: AeronautColors.accent,
        onPrimary: AeronautColors.bgPrimary,
        secondary: AeronautColors.info,
        onSecondary: AeronautColors.textPrimary,
        error: AeronautColors.offline,
        onError: AeronautColors.textPrimary,
        surface: AeronautColors.bgSurface,
        onSurface: AeronautColors.textPrimary,
      ),

      scaffoldBackgroundColor: AeronautColors.bgPrimary,

      appBarTheme: const AppBarTheme(
        backgroundColor: AeronautColors.bgPrimary,
        foregroundColor: AeronautColors.textPrimary,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: heading,
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
          backgroundColor: AeronautColors.accentMuted,
          foregroundColor: AeronautColors.textPrimary,
          elevation: 0,
          padding: const EdgeInsets.symmetric(
            horizontal: spacingLg,
            vertical: spacingSm,
          ),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(radiusSm),
          ),
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
        hintStyle: body.copyWith(color: AeronautColors.textTertiary),
        labelStyle: label,
      ),

      listTileTheme: const ListTileThemeData(
        contentPadding: EdgeInsets.symmetric(
          horizontal: spacingMd,
          vertical: spacingXs,
        ),
        titleTextStyle: body,
        subtitleTextStyle: caption,
        iconColor: AeronautColors.textSecondary,
      ),

      dividerTheme: DividerThemeData(
        color: AeronautColors.divider,
        thickness: 1,
        space: 1,
      ),

      snackBarTheme: SnackBarThemeData(
        backgroundColor: AeronautColors.bgElevated,
        contentTextStyle: body,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusSm),
        ),
        behavior: SnackBarBehavior.floating,
      ),

      floatingActionButtonTheme: const FloatingActionButtonThemeData(
        backgroundColor: AeronautColors.accentMuted,
        foregroundColor: AeronautColors.textPrimary,
      ),

      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: AeronautColors.bgSurface,
        selectedItemColor: AeronautColors.accent,
        unselectedItemColor: AeronautColors.textTertiary,
      ),
    );
  }
}
