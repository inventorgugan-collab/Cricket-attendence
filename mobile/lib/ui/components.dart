import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../features/common/widgets.dart';
import 'theme.dart';

final _rupees = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 0);
final _rupeesPaise = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 2);

/// ₹1,25,000 from paise. Shows paise only when there are some.
String formatRupees(num paise) => (paise % 100 == 0 ? _rupees : _rupeesPaise).format(paise / 100);

String greeting([DateTime? now]) {
  final h = (now ?? DateTime.now()).hour;
  return h < 12 ? 'Good morning' : (h < 17 ? 'Good afternoon' : 'Good evening');
}

/// The green band at the top of each home screen: who you are, which academy,
/// and the one or two numbers that matter today.
class HeroHeader extends StatelessWidget {
  const HeroHeader({super.key, required this.eyebrow, required this.title, this.subtitle, this.stats = const [], this.action});
  final String eyebrow;
  final String title;
  final String? subtitle;
  final List<(String, String)> stats;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    const on = Colors.white;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 4, 12, 8),
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(20),
        gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [AppTheme.pitch, AppTheme.pitchDark]),
      ),
      child: Stack(children: [
        // A faint crease line, like the popping crease on a pitch.
        Positioned(right: -6, top: -4, bottom: -4, child: Container(width: 46, decoration: BoxDecoration(border: Border(left: BorderSide(color: on.withValues(alpha: 0.12), width: 2), right: BorderSide(color: on.withValues(alpha: 0.12), width: 2))))),
        Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(eyebrow.toUpperCase(), style: text.labelSmall?.copyWith(color: on.withValues(alpha: 0.72), letterSpacing: 1.1, fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          Text(title, style: text.headlineSmall?.copyWith(color: on)),
          if (subtitle != null) ...[
            const SizedBox(height: 2),
            Text(subtitle!, style: text.bodyMedium?.copyWith(color: on.withValues(alpha: 0.82))),
          ],
          if (stats.isNotEmpty) ...[
            const SizedBox(height: 14),
            Row(children: [
              for (final (i, (value, label)) in stats.indexed) ...[
                if (i > 0) Container(width: 1, height: 30, margin: const EdgeInsets.symmetric(horizontal: 14), color: on.withValues(alpha: 0.2)),
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(value, style: text.titleLarge?.copyWith(color: on, height: 1.1)),
                  Text(label, style: text.labelSmall?.copyWith(color: on.withValues(alpha: 0.75))),
                ]),
              ],
            ]),
          ],
          if (action != null) ...[const SizedBox(height: 14), action!],
        ]),
      ]),
    );
  }
}

class SectionHeader extends StatelessWidget {
  const SectionHeader(this.title, {super.key, this.trailing, this.padding = const EdgeInsets.fromLTRB(16, 18, 16, 6)});
  final String title;
  final Widget? trailing;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: padding,
      child: Row(children: [
        Expanded(child: Text(title, style: text.titleSmall?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant, letterSpacing: 0.2))),
        ?trailing,
      ]),
    );
  }
}

/// A small rounded label: a status, a kind of session, a warning.
class Pill extends StatelessWidget {
  const Pill(this.text, {super.key, this.color, this.textColor, this.icon});
  final String text;
  final Color? color;
  final Color? textColor;
  final IconData? icon;

  factory Pill.tone(BuildContext context, String text, String tone, {IconData? icon}) {
    final s = Theme.of(context).colorScheme;
    final (bg, fg) = switch (tone) {
      'good' => (s.primaryContainer, s.onPrimaryContainer),
      'warn' => (s.tertiaryContainer, s.onTertiaryContainer),
      'bad' => (s.errorContainer, s.onErrorContainer),
      'accent' => (s.secondaryContainer, s.onSecondaryContainer),
      _ => (s.surfaceContainerHighest, s.onSurfaceVariant),
    };
    return Pill(text, color: bg, textColor: fg, icon: icon);
  }

  @override
  Widget build(BuildContext context) {
    final s = Theme.of(context).colorScheme;
    final fg = textColor ?? s.onSurfaceVariant;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: color ?? s.surfaceContainerHighest, borderRadius: BorderRadius.circular(8)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[Icon(icon, size: 13, color: fg), const SizedBox(width: 4)],
        Text(text, style: Theme.of(context).textTheme.labelSmall?.copyWith(color: fg, fontWeight: FontWeight.w600)),
      ]),
    );
  }
}

/// A session as a card: the time on the left, a stripe in the colour of the
/// kind of session, then what, where and with whom.
class SessionCard extends StatelessWidget {
  const SessionCard({super.key, required this.session, this.lines = const [], this.badges = const [], this.trailing, this.onTap, this.showDay = false});
  final Map<String, dynamic> session;
  final List<String> lines;
  final List<Widget> badges;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool showDay;

  @override
  Widget build(BuildContext context) {
    final s = session;
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    final cancelled = s['status'] == 'cancelled';
    final color = cancelled ? scheme.outline : categoryColor(context, s);
    final start = s['starts_at'] as String?;
    final end = s['ends_at'] as String?;
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: InkWell(
        onTap: onTap,
        child: IntrinsicHeight(
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Container(
              width: 84,
              padding: const EdgeInsets.fromLTRB(12, 14, 6, 12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                if (showDay && start != null) Text(DateFormat('EEE d').format(DateTime.parse(start).toLocal()), style: text.labelSmall?.copyWith(color: scheme.onSurfaceVariant)),
                if (start != null)
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text(formatTime(start), maxLines: 1, style: text.labelLarge?.copyWith(fontWeight: FontWeight.w700)),
                  ),
                if (end != null) Text(formatTime(end), style: text.labelSmall?.copyWith(color: scheme.onSurfaceVariant)),
              ]),
            ),
            Container(width: 4, margin: const EdgeInsets.symmetric(vertical: 12), decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(2))),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 12, 8, 12),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
                  Text(sessionLabel(s),
                      style: text.titleSmall?.copyWith(fontSize: 15, decoration: cancelled ? TextDecoration.lineThrough : null, color: cancelled ? scheme.onSurfaceVariant : null)),
                  for (final l in lines.where((l) => l.isNotEmpty)) Padding(padding: const EdgeInsets.only(top: 2), child: Text(l, style: text.bodySmall)),
                  if (badges.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Wrap(spacing: 6, runSpacing: 4, children: badges)),
                ]),
              ),
            ),
            if (trailing != null) Padding(padding: const EdgeInsets.only(right: 12), child: Center(child: trailing)),
          ]),
        ),
      ),
    );
  }
}

/// One number with a label, for dashboards.
class StatTile extends StatelessWidget {
  const StatTile({super.key, required this.label, required this.value, required this.icon, this.tone, this.onTap});
  final String label;
  final String value;
  final IconData icon;
  final String? tone;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final s = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final (bg, fg) = switch (tone) {
      'bad' => (s.errorContainer, s.onErrorContainer),
      'warn' => (s.tertiaryContainer, s.onTertiaryContainer),
      'accent' => (s.secondaryContainer, s.onSecondaryContainer),
      _ => (s.primaryContainer, s.onPrimaryContainer),
    };
    return Card(
      margin: EdgeInsets.zero,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(children: [
            Container(width: 36, height: 36, decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(10)), child: Icon(icon, size: 19, color: fg)),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(value, style: text.titleLarge?.copyWith(height: 1.1), maxLines: 1, overflow: TextOverflow.ellipsis),
                Text(label, style: text.bodySmall, maxLines: 2, overflow: TextOverflow.ellipsis),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

/// Lays StatTiles out two to a row.
class StatGrid extends StatelessWidget {
  const StatGrid({super.key, required this.children, this.padding = const EdgeInsets.symmetric(horizontal: 12)});
  final List<Widget> children;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Padding(
        padding: padding,
        child: LayoutBuilder(builder: (context, c) {
          final w = (c.maxWidth - 8) / 2;
          return Wrap(spacing: 8, runSpacing: 8, children: [for (final t in children) SizedBox(width: w, child: t)]);
        }),
      );
}

/// A row in a settings-style list: an icon in a tinted square, a title and a
/// line of explanation.
class MenuTile extends StatelessWidget {
  const MenuTile({super.key, required this.icon, required this.title, this.subtitle, this.onTap, this.color, this.trailing});
  final IconData icon;
  final String title;
  final String? subtitle;
  final VoidCallback? onTap;
  final Color? color;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final s = Theme.of(context).colorScheme;
    final c = color ?? s.primary;
    return ListTile(
      leading: Container(width: 40, height: 40, decoration: BoxDecoration(color: c.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(12)), child: Icon(icon, color: c, size: 21)),
      title: Text(title),
      subtitle: subtitle == null ? null : Text(subtitle!),
      trailing: trailing ?? (onTap == null ? null : const Icon(Icons.chevron_right)),
      onTap: onTap,
    );
  }
}

/// A group of rows on one card, like an iOS settings section.
class GroupCard extends StatelessWidget {
  const GroupCard({super.key, required this.children, this.margin = const EdgeInsets.symmetric(horizontal: 12, vertical: 4)});
  final List<Widget> children;
  final EdgeInsets margin;

  @override
  Widget build(BuildContext context) => Card(
        margin: margin,
        child: Column(children: [
          for (final (i, c) in children.indexed) ...[if (i > 0) const Divider(indent: 16, endIndent: 16), c],
        ]),
      );
}

class Avatar extends StatelessWidget {
  const Avatar(this.name, {super.key, this.size = 40});
  final String name;
  final double size;

  @override
  Widget build(BuildContext context) {
    final s = Theme.of(context).colorScheme;
    final initials = name.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).take(2).map((w) => w[0].toUpperCase()).join();
    return CircleAvatar(
      radius: size / 2,
      backgroundColor: s.primaryContainer,
      child: Text(initials, style: TextStyle(color: s.onPrimaryContainer, fontWeight: FontWeight.w700, fontSize: size * 0.36)),
    );
  }
}
