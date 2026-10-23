import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/local_db.dart';
import '../../core/sync_service.dart';
import '../common/widgets.dart';
import 'coach_note_screen.dart';
import 'player_profile_screen.dart';

const _statuses = ['present', 'late', 'absent', 'excused'];

class _RegisterData {
  _RegisterData(this.session, this.rows, this.otherPlayers);
  final Map<String, dynamic>? session;
  final List<_Row> rows;
  final List<Map<String, dynamic>> otherPlayers;
}

class _Row {
  _Row(this.player, this.booking, this.attendance, this.injuries);
  final Map<String, dynamic> player;
  final Map<String, dynamic> booking;
  final Map<String, dynamic>? attendance;
  final List<Map<String, dynamic>> injuries;
}

/// The attendance register. Works fully offline: every tap is saved on the
/// phone first and sent when there is signal.
class SessionRegisterScreen extends StatelessWidget {
  const SessionRegisterScreen({super.key, required this.sessionId});
  final String sessionId;

  Future<_RegisterData> _load(LocalDb local) async {
    final session = await local.get(Kind.session, sessionId);
    final bookings = (await local.list(Kind.booking, sessionId: sessionId)).where((b) => b['status'] == 'confirmed' || b['status'] == 'completed').toList();
    final players = {for (final p in await local.list(Kind.player)) p['id'] as String: p};
    final injuries = await local.list(Kind.injury);
    final rows = <_Row>[];
    for (final b in bookings) {
      final pid = b['player_id'] as String;
      rows.add(_Row(
        players[pid] ?? {'id': pid, 'full_name': 'Player'},
        b,
        await local.attendanceFor(sessionId, pid),
        injuries.where((i) => i['player_id'] == pid).toList(),
      ));
    }
    rows.sort((a, b) => (a.player['full_name'] as String).compareTo(b.player['full_name'] as String));
    final booked = rows.map((r) => r.player['id']).toSet();
    return _RegisterData(session, rows, players.values.where((p) => !booked.contains(p['id'])).toList());
  }

  @override
  Widget build(BuildContext context) {
    final local = context.read<LocalDb>();
    return LocalBuilder<_RegisterData>(
      load: () => _load(local),
      builder: (context, data) {
        final s = data.session;
        if (s == null) return Scaffold(appBar: AppBar(), body: const EmptyState('This session is no longer on your schedule.'));
        final cancelled = s['status'] == 'cancelled';
        final marked = data.rows.where((r) => r.attendance != null).length;
        return Scaffold(
          appBar: AppBar(
            title: Text(sessionLabel(s)),
            actions: [if (!cancelled) _SessionMenu(session: s, data: data)],
          ),
          body: Column(children: [
            const SyncBanner(),
            ListTile(
              title: Text('${formatWhen(s['starts_at'] as String)} to ${formatTime(s['ends_at'] as String)}'),
              subtitle: Text('${humanise(s['session_type'] as String)} · ${humanise(s['status'] as String)} · $marked of ${data.rows.length} marked'),
            ),
            if (cancelled)
              const Padding(padding: EdgeInsets.all(16), child: Text('This session was cancelled. Attendance does not apply and nobody is marked absent.')),
            if (!cancelled)
              Expanded(
                child: data.rows.isEmpty
                    ? const EmptyState('No players are booked into this session.')
                    : ListView.separated(
                        itemCount: data.rows.length,
                        separatorBuilder: (_, _) => const Divider(height: 1),
                        itemBuilder: (context, i) => _PlayerRow(sessionId: sessionId, row: data.rows[i]),
                      ),
              ),
          ]),
        );
      },
    );
  }
}

class _PlayerRow extends StatelessWidget {
  const _PlayerRow({required this.sessionId, required this.row});
  final String sessionId;
  final _Row row;

  @override
  Widget build(BuildContext context) {
    final a = row.attendance;
    final status = a?['status'] as String?;
    final pending = a?['pending'] == true;
    final corrected = a != null && a['original_status'] != null && a['original_status'] != status;
    final restriction = row.injuries.where((i) => i['is_current'] == true).toList();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: InkWell(
              onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => PlayerProfileScreen(playerId: row.player['id'] as String))),
              child: Text(row.player['full_name'] as String, style: Theme.of(context).textTheme.titleMedium),
            ),
          ),
          if (restriction.isNotEmpty)
            Tooltip(message: 'Has a current injury: check before training', child: Icon(Icons.healing, color: Theme.of(context).colorScheme.error)),
          if (row.booking['source'] == 'walk_in') const Padding(padding: EdgeInsets.only(left: 4), child: Chip(label: Text('Walk-in'), visualDensity: VisualDensity.compact)),
          if (pending) const Padding(padding: EdgeInsets.only(left: 4), child: Tooltip(message: 'Saved on phone, not yet sent', child: Icon(Icons.cloud_upload_outlined, size: 18))),
          if (a?['admin_locked'] == true) const Padding(padding: EdgeInsets.only(left: 4), child: Tooltip(message: 'Set by an admin', child: Icon(Icons.lock_outline, size: 18))),
          IconButton(
            tooltip: 'Notes for this player',
            icon: const Icon(Icons.edit_note),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(
              builder: (_) => CoachNoteScreen(sessionId: sessionId, playerId: row.player['id'] as String, playerName: row.player['full_name'] as String),
            )),
          ),
        ]),
        if (restriction.isNotEmpty)
          Text(
            restriction.map((i) => '${i['title']}${i['professional_restrictions'] != null ? ': ${i['professional_restrictions']}' : ''}').join('\n'),
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        const SizedBox(height: 6),
        SegmentedButton<String>(
          emptySelectionAllowed: true,
          showSelectedIcon: false,
          segments: [for (final s in _statuses) ButtonSegment(value: s, label: Text(humanise(s)))],
          selected: {if (status != null && _statuses.contains(status)) status},
          onSelectionChanged: (sel) async {
            if (sel.isEmpty) return;
            final next = sel.first;
            String? note;
            if (a != null && status != null && next != status) {
              note = await _askReason(context, 'Change ${humanise(status)} to ${humanise(next)}');
              if (note == null) return;
            }
            if (!context.mounted) return;
            await context.read<SyncService>().markAttendance(sessionId: sessionId, playerId: row.player['id'] as String, status: next, note: note);
          },
        ),
        if (corrected) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Corrected from ${humanise(a['original_status'] as String)}', style: Theme.of(context).textTheme.bodySmall)),
      ]),
    );
  }
}

Future<String?> _askReason(BuildContext context, String title) {
  final c = TextEditingController();
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: TextField(controller: c, decoration: const InputDecoration(labelText: 'Reason (optional)'), autofocus: true),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('Change')),
      ],
    ),
  );
}

class _SessionMenu extends StatelessWidget {
  const _SessionMenu({required this.session, required this.data});
  final Map<String, dynamic> session;
  final _RegisterData data;

  @override
  Widget build(BuildContext context) {
    final sync = context.read<SyncService>();
    final id = session['id'] as String;
    return PopupMenuButton<String>(
      onSelected: (v) async {
        switch (v) {
          case 'start':
            await sync.setSessionStatus(id, 'in_progress');
          case 'complete':
            final unmarked = data.rows.where((r) => r.attendance == null).length;
            if (unmarked > 0) {
              final ok = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: const Text('Finish session?'),
                  content: Text('$unmarked player${unmarked == 1 ? ' has' : 's have'} no attendance yet. They will show in the missing-attendance report.'),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Go back')),
                    FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Finish anyway')),
                  ],
                ),
              );
              if (ok != true) return;
            }
            await sync.setSessionStatus(id, 'completed');
          case 'interrupted':
            await sync.setSessionStatus(id, 'interrupted');
          case 'walkin':
            if (!context.mounted) return;
            final player = await showDialog<Map<String, dynamic>>(
              context: context,
              builder: (ctx) => SimpleDialog(title: const Text('Add a walk-in'), children: [
                if (data.otherPlayers.isEmpty) const Padding(padding: EdgeInsets.all(16), child: Text('No other players are available offline.')),
                for (final p in data.otherPlayers) SimpleDialogOption(onPressed: () => Navigator.pop(ctx, p), child: Text(p['full_name'] as String)),
              ]),
            );
            if (player == null) return;
            await sync.markAttendance(sessionId: id, playerId: player['id'] as String, status: 'present', walkIn: true);
            // Walk-ins appear once the server confirms the booking.
            if (context.mounted) showMessage(context, '${player['full_name']} added as a walk-in. They appear here after the next sync.');
          case 'notes':
            if (!context.mounted) return;
            await Navigator.of(context).push(MaterialPageRoute(builder: (_) => CoachNoteScreen(sessionId: id)));
        }
      },
      itemBuilder: (_) => const [
        PopupMenuItem(value: 'start', child: Text('Start session')),
        PopupMenuItem(value: 'complete', child: Text('Finish session')),
        PopupMenuItem(value: 'interrupted', child: Text('Mark interrupted (e.g. rain)')),
        PopupMenuItem(value: 'walkin', child: Text('Add a walk-in')),
        PopupMenuItem(value: 'notes', child: Text('Session notes')),
      ],
    );
  }
}
