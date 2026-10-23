import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../common/widgets.dart';

final _ymd = DateFormat('yyyy-MM-dd');

/// Leave on record. With a [coachId] it is that coach's own list; without one
/// (admins) it is the whole academy's, and new leave asks which coach.
class LeaveScreen extends StatefulWidget {
  const LeaveScreen({super.key, this.coachId});
  final String? coachId;
  @override
  State<LeaveScreen> createState() => _LeaveScreenState();
}

class _LeaveScreenState extends State<LeaveScreen> {
  int _version = 0;

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    final coachId = widget.coachId;
    return Scaffold(
      appBar: AppBar(title: Text(coachId == null ? 'Coach leave' : 'My leave')),
      body: OnlineLoader<List<dynamic>>(
        key: ValueKey(_version),
        load: () async => await api.get(coachId == null ? '/v1/leave' : '/v1/coaches/$coachId/leave') as List<dynamic>,
        builder: (context, items, reload) {
          if (items.isEmpty) return const EmptyState('No leave recorded.');
          return ListView(children: [for (final l in items.cast<Map<String, dynamic>>()) _LeaveTile(l, reload, showCoach: coachId == null)]);
        },
      ),
      floatingActionButton: FloatingActionButton.extended(
        icon: const Icon(Icons.event_busy),
        label: const Text('Record leave'),
        onPressed: () async {
          if (await recordPlannedLeave(context, coachId: coachId)) setState(() => _version++);
        },
      ),
    );
  }
}

class _LeaveTile extends StatelessWidget {
  const _LeaveTile(this.l, this.reload, {required this.showCoach});
  final Map<String, dynamic> l;
  final Future<void> Function() reload;
  final bool showCoach;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final cancelled = l['status'] == 'cancelled';
    final emergency = l['kind'] == 'emergency';
    final ended = DateTime.parse(l['ends_at'] as String).isBefore(DateTime.now());
    final affected = l['affectedSessions'] as int?;
    return ListTile(
      leading: Icon(emergency ? Icons.warning_amber : Icons.beach_access, color: cancelled ? null : (emergency ? scheme.error : scheme.primary)),
      title: Text('${showCoach ? '${l['coach_name']} · ' : ''}${emergency ? 'Emergency' : 'Planned'}${cancelled ? ' (cancelled)' : ''}',
          style: cancelled ? const TextStyle(decoration: TextDecoration.lineThrough) : null),
      subtitle: Text('${_range(l)}${l['reason'] == null ? '' : '\n${l['reason']}'}\nRecorded by ${l['recorded_by_name']}'
          '${affected != null && affected > 0 ? ' · $affected session${affected == 1 ? '' : 's'} need a coach' : ''}'),
      isThreeLine: true,
      trailing: cancelled || ended
          ? null
          : TextButton(
              onPressed: () async {
                try {
                  await context.read<ApiClient>().post('/v1/leave/${l['id']}/cancel', {});
                  await reload();
                } catch (e) {
                  if (context.mounted) showMessage(context, e);
                }
              },
              child: const Text('Cancel'),
            ),
    );
  }

  static String _range(Map<String, dynamic> l) {
    final s = DateTime.parse(l['starts_at'] as String).toLocal();
    final e = DateTime.parse(l['ends_at'] as String).toLocal();
    final wholeDays = s.hour == 0 && s.minute == 0 && e.hour == 0 && e.minute == 0;
    if (wholeDays) {
      final last = e.subtract(const Duration(days: 1));
      return last.difference(s).inDays == 0 ? DateFormat('EEE d MMM').format(s) : '${DateFormat('EEE d MMM').format(s)} to ${DateFormat('EEE d MMM').format(last)}';
    }
    return '${formatWhen(s.toIso8601String())} to ${formatWhen(e.toIso8601String())}';
  }
}

/// Planned time off, as whole days. Returns true if leave was recorded.
Future<bool> recordPlannedLeave(BuildContext context, {String? coachId}) async {
  final api = context.read<ApiClient>();
  var forCoach = coachId;
  if (forCoach == null) {
    final coaches = (await api.get('/v1/coaches') as List).cast<Map<String, dynamic>>();
    if (!context.mounted) return false;
    forCoach = await showDialog<String>(
      context: context,
      builder: (ctx) => SimpleDialog(title: const Text('Which coach?'), children: [
        for (final c in coaches) SimpleDialogOption(onPressed: () => Navigator.pop(ctx, c['id'] as String), child: Text(c['full_name'] as String)),
      ]),
    );
    if (forCoach == null || !context.mounted) return false;
  }
  final now = DateTime.now();
  final range = await showDateRangePicker(
    context: context,
    firstDate: DateTime(now.year, now.month, now.day),
    lastDate: now.add(const Duration(days: 365)),
    helpText: 'Days away',
  );
  if (range == null || !context.mounted) return false;
  final reason = TextEditingController();
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('Record leave'),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('${DateFormat('EEE d MMM').format(range.start)} to ${DateFormat('EEE d MMM').format(range.end)}'),
        const SizedBox(height: 12),
        TextField(controller: reason, decoration: const InputDecoration(labelText: 'Reason (optional)', border: OutlineInputBorder())),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save')),
      ],
    ),
  );
  if (ok != true || !context.mounted) return false;
  try {
    final r = await api.post('/v1/coaches/$forCoach/leave', {
      'kind': 'planned',
      'date': _ymd.format(range.start),
      'untilDate': _ymd.format(range.end),
      if (reason.text.trim().isNotEmpty) 'reason': reason.text.trim(),
    }) as Map<String, dynamic>;
    if (context.mounted) showMessage(context, _affectedText(r));
    return true;
  } catch (e) {
    if (context.mounted) showMessage(context, e);
    return false;
  }
}

/// "I can't come in today": records emergency leave from now until the end of
/// the day and tells the admin straight away.
Future<void> reportEmergency(BuildContext context, String coachId) async {
  final reason = TextEditingController();
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      icon: const Icon(Icons.warning_amber),
      title: const Text("Can't come in today?"),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        const Text('The academy is told straight away so your sessions for the rest of today can go to another coach.'),
        const SizedBox(height: 12),
        TextField(controller: reason, decoration: const InputDecoration(labelText: 'Reason (optional)', border: OutlineInputBorder())),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Tell the academy')),
      ],
    ),
  );
  if (ok != true || !context.mounted) return;
  try {
    final r = await context.read<ApiClient>().post('/v1/coaches/$coachId/leave', {
      'kind': 'emergency',
      if (reason.text.trim().isNotEmpty) 'reason': reason.text.trim(),
    }) as Map<String, dynamic>;
    if (context.mounted) showMessage(context, 'The academy has been told. ${_affectedText(r)}');
  } on OfflineException {
    if (context.mounted) showMessage(context, 'No connection. Please phone the academy.');
  } catch (e) {
    if (context.mounted) showMessage(context, e);
  }
}

String _affectedText(Map<String, dynamic> r) {
  final n = (r['affectedSessions'] as List).length;
  return n == 0 ? 'Leave recorded. No sessions are affected.' : 'Leave recorded. $n session${n == 1 ? '' : 's'} will be given to another coach.';
}
