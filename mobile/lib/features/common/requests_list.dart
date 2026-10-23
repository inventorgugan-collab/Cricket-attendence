import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import 'widgets.dart';

/// Booking requests waiting for the academy: sessions players asked for at a
/// time of their choosing, and requests for scheduled sessions. Coaches see
/// their own; admins see all. A coach who can't take a requested time passes
/// it to the next free coach in line.
class StaffRequestsList extends StatelessWidget {
  const StaffRequestsList({super.key, this.emptyText = 'No requests waiting.'});
  final String emptyText;

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return OnlineLoader<List<dynamic>>(
      load: () async => ((await api.get('/v1/bookings?status=pending')) as List).where((b) => (b['approvals_needed'] as List).contains('staff')).toList().reversed.toList(),
      builder: (context, items, reload) {
        if (items.isEmpty) return EmptyState(emptyText);
        return ListView(padding: const EdgeInsets.all(8), children: [
          for (final b in items.cast<Map<String, dynamic>>()) _RequestCard(b, reload),
        ]);
      },
    );
  }
}

class _RequestCard extends StatelessWidget {
  const _RequestCard(this.b, this.reload);
  final Map<String, dynamic> b;
  final Future<void> Function() reload;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final requested = b['origin'] == 'request';
    final coaches = (b['coaches'] as List).map((c) => c['full_name']).join(', ');
    final reasons = (b['review_reasons'] as List).cast<String>().where((r) => !r.startsWith('Requested time with')).toList();
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 8, 6),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(b['player_name'] as String, style: text.titleMedium)),
            if (requested) Chip(label: const Text('Asked for this time'), visualDensity: VisualDensity.compact, backgroundColor: Theme.of(context).colorScheme.tertiaryContainer),
          ]),
          Text('${b['category_name'] ?? sessionLabel(b)} · ${formatWhen(b['starts_at'] as String)}'),
          if (coaches.isNotEmpty) Text('With $coaches', style: text.bodySmall),
          if ((b['training_focus'] as String?)?.isNotEmpty == true) Text('Note: ${b['training_focus']}', style: text.bodySmall),
          for (final r in reasons) Text(r, style: text.bodySmall?.copyWith(color: Theme.of(context).colorScheme.error)),
          if ((b['approvals_needed'] as List).contains('guardian')) Text('Also waiting for a parent', style: text.bodySmall),
          Row(mainAxisAlignment: MainAxisAlignment.end, children: [
            TextButton(onPressed: () => _decline(context), child: const Text('Decline')),
            if (requested) TextButton(onPressed: () => _pass(context), child: const Text('Pass to next coach')),
            FilledButton(onPressed: () => _act(context, () => context.read<ApiClient>().post('/v1/bookings/${b['id']}/approve'), (r) => r['status'] == 'confirmed' ? 'Confirmed. Everyone has been told.' : 'Approved. ${humanise(r['status'] as String)}'), child: const Text('Confirm')),
          ]),
        ]),
      ),
    );
  }

  Future<void> _decline(BuildContext context) async {
    final reason = await askText(context, title: 'Decline this request?', label: 'Reason the family will see', initial: 'Not available at that time');
    if (reason == null || !context.mounted) return;
    await _act(context, () => context.read<ApiClient>().post('/v1/bookings/${b['id']}/reject', {'reason': reason}), (_) => 'Declined. The family has been told.');
  }

  Future<void> _pass(BuildContext context) async {
    await _act(context, () => context.read<ApiClient>().post('/v1/session-requests/${b['id']}/pass', {}),
        (r) => r['coach'] == null ? 'No other coach is free, so the request was declined and the family told.' : 'Passed to ${r['coach']['full_name']}.');
  }

  Future<void> _act(BuildContext context, Future<dynamic> Function() call, String Function(dynamic) done) async {
    try {
      final r = await call();
      if (context.mounted) showMessage(context, done(r));
      await reload();
    } catch (e) {
      if (context.mounted) showMessage(context, e);
    }
  }
}

/// A one-line text prompt. Returns null if cancelled.
Future<String?> askText(BuildContext context, {required String title, required String label, String? initial, String action = 'OK'}) async {
  final c = TextEditingController(text: initial);
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: TextField(controller: c, autofocus: true, decoration: InputDecoration(labelText: label, border: const OutlineInputBorder())),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(action)),
      ],
    ),
  );
  return ok == true ? c.text.trim() : null;
}
