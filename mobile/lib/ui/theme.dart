import 'package:flutter/material.dart';

/// The app's look: a deep pitch green with a cricket-ball red accent, calm
/// off-white surfaces, flat cards with a hairline border, and Inter type.
class AppTheme {
  static const pitch = Color(0xFF0E5A3A);
  static const pitchDark = Color(0xFF083D27);
  static const ball = Color(0xFFB4441C);

  static ThemeData light() => _build(Brightness.light);
  static ThemeData dark() => _build(Brightness.dark);

  static ThemeData _build(Brightness b) {
    final dark = b == Brightness.dark;
    final scheme = ColorScheme.fromSeed(seedColor: pitch, brightness: b).copyWith(
      primary: dark ? const Color(0xFF7FD3A5) : pitch,
      onPrimary: dark ? const Color(0xFF00391F) : Colors.white,
      primaryContainer: dark ? const Color(0xFF12452E) : const Color(0xFFD9F0E3),
      onPrimaryContainer: dark ? const Color(0xFFBDEFD2) : const Color(0xFF06331F),
      secondary: dark ? const Color(0xFFFFB59A) : ball,
      secondaryContainer: dark ? const Color(0xFF5C2410) : const Color(0xFFFBE3D9),
      onSecondaryContainer: dark ? const Color(0xFFFFDBCF) : const Color(0xFF5A1C06),
      tertiaryContainer: dark ? const Color(0xFF3D3415) : const Color(0xFFFBF0CF),
      onTertiaryContainer: dark ? const Color(0xFFF5E2A6) : const Color(0xFF4A3A05),
      surface: dark ? const Color(0xFF151916) : Colors.white,
      surfaceContainerLowest: dark ? const Color(0xFF0F1210) : const Color(0xFFF4F6F2),
      surfaceContainerLow: dark ? const Color(0xFF1A1F1B) : const Color(0xFFF7F8F5),
      surfaceContainer: dark ? const Color(0xFF1E2420) : const Color(0xFFF0F2EE),
      surfaceContainerHighest: dark ? const Color(0xFF2A312C) : const Color(0xFFE8EBE6),
      outlineVariant: dark ? const Color(0xFF2E3631) : const Color(0xFFE1E5DF),
      error: dark ? const Color(0xFFFFB4AB) : const Color(0xFFB42318),
      errorContainer: dark ? const Color(0xFF5C1A14) : const Color(0xFFFDE7E4),
      onErrorContainer: dark ? const Color(0xFFFFDAD5) : const Color(0xFF5F0F09),
    );
    final base = ThemeData(useMaterial3: true, colorScheme: scheme, fontFamily: 'Inter');
    final text = base.textTheme.copyWith(
      headlineLarge: base.textTheme.headlineLarge?.copyWith(fontWeight: FontWeight.w700, letterSpacing: -0.8),
      headlineMedium: base.textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w700, letterSpacing: -0.6),
      headlineSmall: base.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700, letterSpacing: -0.4),
      titleLarge: base.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700, letterSpacing: -0.3),
      titleMedium: base.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600, letterSpacing: -0.1),
      titleSmall: base.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
      labelLarge: base.textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w600),
      bodyMedium: base.textTheme.bodyMedium?.copyWith(height: 1.4),
      bodySmall: base.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant, height: 1.35),
    );
    final radius = BorderRadius.circular(14);
    return base.copyWith(
      textTheme: text,
      scaffoldBackgroundColor: scheme.surfaceContainerLowest,
      appBarTheme: AppBarTheme(
        backgroundColor: scheme.surfaceContainerLowest,
        surfaceTintColor: Colors.transparent,
        scrolledUnderElevation: 0,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: text.titleLarge?.copyWith(color: scheme.onSurface),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: scheme.surface,
        surfaceTintColor: Colors.transparent,
        margin: const EdgeInsets.symmetric(vertical: 5),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: BorderSide(color: scheme.outlineVariant)),
        clipBehavior: Clip.antiAlias,
      ),
      listTileTheme: ListTileThemeData(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
        iconColor: scheme.onSurfaceVariant,
        titleTextStyle: text.bodyLarge?.copyWith(fontWeight: FontWeight.w600, color: scheme.onSurface),
        subtitleTextStyle: text.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: scheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        height: 66,
        indicatorColor: scheme.primaryContainer,
        labelTextStyle: WidgetStateProperty.resolveWith((s) => text.labelSmall?.copyWith(
              fontWeight: s.contains(WidgetState.selected) ? FontWeight.w700 : FontWeight.w500,
              color: s.contains(WidgetState.selected) ? scheme.onSurface : scheme.onSurfaceVariant,
            )),
        iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(
              size: 22,
              color: s.contains(WidgetState.selected) ? scheme.onPrimaryContainer : scheme.onSurfaceVariant,
            )),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: scheme.outlineVariant)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: scheme.outlineVariant)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: scheme.primary, width: 1.6)),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(0, 46),
          padding: const EdgeInsets.symmetric(horizontal: 18),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: text.labelLarge,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(0, 46),
          padding: const EdgeInsets.symmetric(horizontal: 16),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          side: BorderSide(color: scheme.outlineVariant),
          textStyle: text.labelLarge,
        ),
      ),
      textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(textStyle: text.labelLarge)),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: scheme.primary,
        foregroundColor: scheme.onPrimary,
        elevation: 2,
        highlightElevation: 4,
        shape: RoundedRectangleBorder(borderRadius: radius),
        extendedTextStyle: text.labelLarge,
      ),
      chipTheme: ChipThemeData(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        side: BorderSide(color: scheme.outlineVariant),
        labelStyle: text.labelMedium?.copyWith(fontWeight: FontWeight.w600),
        backgroundColor: scheme.surface,
        selectedColor: scheme.primaryContainer,
        checkmarkColor: scheme.onPrimaryContainer,
      ),
      dividerTheme: DividerThemeData(color: scheme.outlineVariant, space: 1, thickness: 1),
      dialogTheme: DialogThemeData(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)), backgroundColor: scheme.surface, surfaceTintColor: Colors.transparent),
      bottomSheetTheme: BottomSheetThemeData(backgroundColor: scheme.surface, surfaceTintColor: Colors.transparent, showDragHandle: true),
      snackBarTheme: SnackBarThemeData(behavior: SnackBarBehavior.floating, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
      segmentedButtonTheme: SegmentedButtonThemeData(
        style: SegmentedButton.styleFrom(
            selectedBackgroundColor: scheme.primaryContainer,
            selectedForegroundColor: scheme.onPrimaryContainer,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)), side: BorderSide(color: scheme.outlineVariant)),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(linearTrackColor: scheme.surfaceContainerHighest, color: scheme.primary),
      popupMenuTheme: PopupMenuThemeData(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)), surfaceTintColor: Colors.transparent, color: scheme.surface),
    );
  }
}

/// A colour per kind of session, so a schedule can be read at a glance.
Color categoryColor(BuildContext context, Map<String, dynamic> s) {
  final dark = Theme.of(context).brightness == Brightness.dark;
  final code = (s['category_code'] as String?) ?? (s['session_type'] as String?) ?? '';
  final light = switch (code) {
    'one_on_one' => const Color(0xFF2563A8),
    'one_on_two' => const Color(0xFF7C4DBE),
    'group' => AppTheme.pitch,
    'strength_conditioning' => const Color(0xFFC77700),
    _ => const [Color(0xFF0F7C86), Color(0xFFB4441C), Color(0xFF5B6B1E), Color(0xFF8E3B6E)][code.hashCode.abs() % 4],
  };
  return dark ? Color.lerp(light, Colors.white, 0.35)! : light;
}
