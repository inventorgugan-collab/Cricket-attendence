import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/sync_service.dart';
import 'widgets.dart';

/// Changes the server refused or held as conflicts. Nothing is silently lost:
/// the user sees what they tried, why it didn't apply, and what the server has.
class SyncProblemsScreen extends StatefulWidget {
  const SyncProblemsScreen({super.key});
  @override
  State<SyncProblemsScreen> createState() => _SyncProblemsScreenState();
}

class _SyncProblemsScreenState extends State<SyncProblemsScreen> {
  late Future<List<Map<String, dynamic>>> _items = context.read<SyncService>().problemsList();

  String _describe(Map<String, dynamic> p) {
    final payload = p['payload'] as Map<String, dynamic>;
    return switch (p['type']) {
      'attendance.mark' => 'Attendance: ${humanise(payload['status'] as String?)}',
      'coach_note.upsert' => 'Coaching note',
      'journal.upsert' => 'Journal entry for ${payload['entryDate']}',
      'booking.request' => 'Booking request',
      'session.status' => 'Session marked ${humanise(payload['status'] as String?)}',
      _ => p['type'] as String,
    };
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Changes needing attention')),
      body: FutureBuilder(
        future: _items,
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final items = snap.data!;
          if (items.isEmpty) return const EmptyState('Nothing needs attention.');
          return ListView.separated(
            itemCount: items.length,
            separatorBuilder: (_, _) => const Divider(height: 1),
            itemBuilder: (context, i) {
              final p = items[i];
              final result = p['result'] as Map<String, dynamic>?;
              final conflict = p['status'] == 'conflict';
              final detail = result == null ? null : (conflict ? result['reason'] : result['message']);
              final why = (detail as String?) ?? 'Not applied';
              return ListTile(
                leading: Icon(conflict ? Icons.call_split : Icons.block),
                title: Text(_describe(p)),
                subtitle: Text(
                  '${conflict ? 'Held for review: ' : 'Not saved: '}$why\n'
                  '${conflict ? 'The academy\'s version is shown in the app. An admin can choose which to keep.' : 'Made ${formatWhen(p['clientTime'] as String)}'}',
                ),
                isThreeLine: true,
                trailing: TextButton(
                  onPressed: () async {
                    await context.read<SyncService>().dismissProblem(p['id'] as String);
                    setState(() => _items = context.read<SyncService>().problemsList());
                  },
                  child: const Text('Dismiss'),
                ),
              );
            },
          );
        },
      ),
    );
  }
}
