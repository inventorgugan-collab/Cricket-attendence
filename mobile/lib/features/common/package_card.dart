import 'package:flutter/material.dart';

import 'widgets.dart';

/// A training package with what's been used and what's left. A package made of
/// parts (e.g. 9 one-on-one + 3 strength & conditioning) shows each part.
class PackageCard extends StatelessWidget {
  const PackageCard(this.p, {super.key, this.onAdjust});
  final Map<String, dynamic> p;
  final void Function(Map<String, dynamic>? part)? onAdjust;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final parts = ((p['parts'] as List?) ?? const []).cast<Map<String, dynamic>>();
    final active = p['status'] == 'active';
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 6),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(p['name'] as String, style: text.titleMedium)),
            if (!active) Chip(label: Text(humanise(p['status'] as String)), visualDensity: VisualDensity.compact),
          ]),
          Text('Valid ${_d(p['starts_on'])} to ${_d(p['expires_on'])}', style: text.bodySmall),
          const SizedBox(height: 10),
          if (p['kind'] != 'fixed')
            Text('Flexible training · ${p['sessions_used']} sessions attended')
          else if (parts.isEmpty)
            _PartRow(label: 'Sessions', total: p['total_sessions'] as int, remaining: p['remaining'] as int, used: p['sessions_used'] as int, reserved: p['reserved_by_bookings'] as int,
                onAdjust: onAdjust == null ? null : () => onAdjust!(null))
          else
            for (final part in parts)
              _PartRow(
                label: part['category_name'] as String,
                total: part['total_sessions'] as int,
                remaining: part['remaining'] as int,
                used: part['used'] as int,
                reserved: part['reserved_by_bookings'] as int,
                onAdjust: onAdjust == null ? null : () => onAdjust!(part),
              ),
          if (parts.length > 1) Text('${p['remaining']} of ${p['total_sessions']} sessions left in total', style: text.bodySmall),
        ]),
      ),
    );
  }

  static String _d(Object? iso) => iso == null ? '' : formatDay('${iso}T12:00:00');
}

class _PartRow extends StatelessWidget {
  const _PartRow({required this.label, required this.total, required this.remaining, required this.used, required this.reserved, this.onAdjust});
  final String label;
  final int total, remaining, used, reserved;
  final VoidCallback? onAdjust;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final low = remaining <= 2;
    final extra = remaining + used - total; // adjustments made by the academy
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(label, style: const TextStyle(fontWeight: FontWeight.w600))),
          Text('$remaining left', style: TextStyle(fontWeight: FontWeight.w600, color: low ? scheme.error : null)),
          if (onAdjust != null) IconButton(visualDensity: VisualDensity.compact, tooltip: 'Adjust $label', icon: const Icon(Icons.tune, size: 18), onPressed: onAdjust),
        ]),
        const SizedBox(height: 4),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(value: total == 0 ? 0 : (used / (total + (extra > 0 ? extra : 0))).clamp(0, 1), minHeight: 8),
        ),
        const SizedBox(height: 4),
        Text('$used attended of $total${extra != 0 ? ' (${extra > 0 ? '+' : ''}$extra adjusted)' : ''}${reserved > 0 ? ' · $reserved booked ahead' : ''}',
            style: Theme.of(context).textTheme.bodySmall),
      ]),
    );
  }
}
