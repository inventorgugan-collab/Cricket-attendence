import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/app_state.dart';
import '../../core/local_db.dart';
import '../../core/sync_service.dart';
import '../common/notifications_screen.dart';
import '../../ui/components.dart';
import '../common/widgets.dart';
import '../common/package_card.dart';
import 'book_session_screen.dart';
import 'journal_entry_screen.dart';

/// Home for players and for parents. A parent picks which linked child to look
/// at; they never need the child's password.
class FamilyHome extends StatefulWidget {
  const FamilyHome({super.key});
  @override
  State<FamilyHome> createState() => _FamilyHomeState();
}

class _FamilyHomeState extends State<FamilyHome> {
  int _tab = 0;
  String? _childId;

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final isGuardian = app.role == 'guardian';
    final children = app.children;
    final playerId = isGuardian ? (_childId ?? (children.isEmpty ? null : children.first['id'] as String)) : app.profileId;
    final tabs = <(String, IconData, Widget)>[
      ('Sessions', Icons.event, playerId == null ? const EmptyState('No linked players yet.') : _Sessions(playerId: playerId)),
      ('Journal', Icons.menu_book_outlined, playerId == null ? const SizedBox() : _Journal(playerId: playerId, canWrite: !isGuardian)),
      ('Coach', Icons.sports_cricket, playerId == null ? const SizedBox() : _Feedback(playerId: playerId)),
      ('Progress', Icons.insights, playerId == null ? const SizedBox() : _Progress(playerId: playerId)),
      if (isGuardian) ('Approve', Icons.how_to_reg, const _GuardianApprovals()),
      ('Alerts', Icons.notifications_outlined, const NotificationsScreen()),
    ];
    final tab = _tab.clamp(0, tabs.length - 1);
    return Scaffold(
      appBar: AppBar(
        title: isGuardian && children.length > 1
            ? DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  value: playerId,
                  items: [for (final c in children) DropdownMenuItem(value: c['id'] as String, child: Text(c['full_name'] as String))],
                  onChanged: (v) => setState(() => _childId = v),
                ),
              )
            : Text(isGuardian && children.isNotEmpty ? children.first['full_name'] as String : tabs[tab].$1),
        actions: [
          IconButton(tooltip: 'Sign out', icon: const Icon(Icons.logout), onPressed: () => context.read<AppState>().signOut()),
        ],
      ),
      body: Column(children: [if (tab != 0) const SyncBanner(), Expanded(child: tabs[tab].$3)]),
      floatingActionButton: tab == 0 && playerId != null && (app.role == 'player' || children.any((c) => c['id'] == playerId && c['can_book'] == true))
          ? FloatingActionButton.extended(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => BookSessionScreen(playerId: playerId))),
              icon: const Icon(Icons.add),
              label: const Text('Book a session'),
            )
          : tab == 1 && !isGuardian && playerId != null
              ? FloatingActionButton.extended(
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => JournalEntryScreen(playerId: playerId))),
                  icon: const Icon(Icons.edit),
                  label: const Text('Add entry'),
                )
              : null,
      bottomNavigationBar: NavigationBar(
        selectedIndex: tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [for (final t in tabs) NavigationDestination(icon: Icon(t.$2), label: t.$1)],
      ),
    );
  }
}

class _Sessions extends StatelessWidget {
  const _Sessions({required this.playerId});
  final String playerId;

  @override
  Widget build(BuildContext context) {
    final local = context.read<LocalDb>();
    final app = context.read<AppState>();
    return LocalBuilder<(List<(Map<String, dynamic>?, Map<String, dynamic>)>, Map<String, dynamic>?)>(
      load: () async {
        final bookings = await local.list(Kind.booking, playerId: playerId);
        final out = <(Map<String, dynamic>?, Map<String, dynamic>)>[];
        for (final b in bookings) {
          out.add((await local.get(Kind.session, b['session_id'] as String), b));
        }
        out.sort((a, b) => ((a.$1?['starts_at'] as String?) ?? '').compareTo((b.$1?['starts_at'] as String?) ?? ''));
        final player = await local.get(Kind.player, playerId);
        return (out.where((x) => x.$1 == null || DateTime.parse(x.$1!['ends_at'] as String).isAfter(DateTime.now().subtract(const Duration(days: 1)))).toList(), player);
      },
      builder: (context, data) {
        final (items, player) = data;
        final upcoming = items.where((x) => x.$1 != null && x.$1!['status'] != 'cancelled' && ['confirmed', 'pending'].contains(x.$2['status'])).toList();
        final next = upcoming.where((x) => x.$2['status'] == 'confirmed' && DateTime.parse(x.$1!['starts_at'] as String).isAfter(DateTime.now())).firstOrNull?.$1;
        final first = ((player?['full_name'] as String?) ?? (app.user?['displayName'] as String?) ?? '').split(' ').first;
        final children = <Widget>[
          HeroHeader(
            eyebrow: app.academyName,
            title: app.role == 'guardian' ? '$first\'s training' : '${greeting()}${first.isEmpty ? '' : ', $first'}',
            subtitle: next == null ? 'No confirmed session coming up.' : 'Next: ${sessionLabel(next)}, ${dayLabel(next['starts_at'] as String).toLowerCase()} at ${formatTime(next['starts_at'] as String)}',
            stats: [
              ('${items.where((x) => x.$2['status'] == 'confirmed' && x.$1?['status'] != 'cancelled').length}', 'confirmed'),
              ('${items.where((x) => x.$2['status'] == 'pending' || x.$2['status'] == 'queued').length}', 'awaiting reply'),
            ],
          ),
          const SyncBanner(),
        ];
        if (items.isEmpty) {
          children.add(const Padding(padding: EdgeInsets.all(32), child: Text('No upcoming sessions. Tap "Book a session" to ask for one.', textAlign: TextAlign.center)));
        }
        String? lastDay;
        for (final (s, b) in items) {
          if (s == null) {
            children.add(Card(
              margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              child: ListTile(title: const Text('Session request'), subtitle: const Text('Details arrive after the request is sent'), trailing: StatusChip(b['status'] as String)),
            ));
            continue;
          }
          final day = dayLabel(s['starts_at'] as String);
          if (day != lastDay) {
            children.add(SectionHeader(day));
            lastDay = day;
          }
          final coaches = (s['coaches'] as List?)?.map((c) => c['full_name']).join(', ') ?? '';
          children.add(SessionCard(
            session: s,
            lines: [
              if (coaches.isNotEmpty) 'With $coaches',
              [s['location_name'], s['area_name']].whereType<String>().join(' · '),
            ],
            badges: [
              if (s['status'] == 'cancelled') Pill.tone(context, 'Session cancelled', 'bad') else StatusChip(b['status'] as String),
              if (b['status'] == 'waitlisted') Pill.tone(context, 'Position ${b['waitlist_position']}', 'neutral'),
            ],
          ));
        }
        children.add(const SizedBox(height: 88));
        return RefreshIndicator(onRefresh: () => context.read<SyncService>().sync(), child: ListView(children: children));
      },
    );
  }
}

class _Journal extends StatelessWidget {
  const _Journal({required this.playerId, required this.canWrite});
  final String playerId;
  final bool canWrite;

  @override
  Widget build(BuildContext context) {
    final local = context.read<LocalDb>();
    return LocalBuilder<List<Map<String, dynamic>>>(
      load: () async => (await local.list(Kind.journal, playerId: playerId, descending: true)).where((j) => j['deleted'] != true).toList(),
      builder: (context, entries) {
        if (entries.isEmpty) return EmptyState(canWrite ? 'Record what you practised today with "Add entry".' : 'No journal entries yet.', icon: Icons.menu_book_outlined);
        final text = Theme.of(context).textTheme;
        return ListView(padding: const EdgeInsets.fromLTRB(0, 4, 0, 88), children: [
          for (final j in entries)
            Card(
              margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              child: InkWell(
                onTap: canWrite ? () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => JournalEntryScreen(playerId: playerId, existing: j))) : null,
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Expanded(child: Text((j['skills'] as String?) ?? 'Training', style: text.titleSmall)),
                      if (j['pending'] == true) Pill.tone(context, 'Not sent yet', 'warn', icon: Icons.cloud_upload_outlined),
                    ]),
                    Text(formatDay('${j['entryDate']}T12:00:00'), style: text.bodySmall),
                    if (j['drills'] != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(j['drills'] as String)),
                    if (j['wentWell'] != null) _Line(Icons.thumb_up_alt_outlined, j['wentWell'] as String),
                    if (j['toImprove'] != null) _Line(Icons.trending_up, j['toImprove'] as String),
                  ]),
                ),
              ),
            ),
        ]);
      },
    );
  }
}

class _Line extends StatelessWidget {
  const _Line(this.icon, this.text);
  final IconData icon;
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(icon, size: 16, color: Theme.of(context).colorScheme.primary),
          const SizedBox(width: 8),
          Expanded(child: Text(text)),
        ]),
      );
}

class _Feedback extends StatelessWidget {
  const _Feedback({required this.playerId});
  final String playerId;

  @override
  Widget build(BuildContext context) {
    final local = context.read<LocalDb>();
    return LocalBuilder<List<Map<String, dynamic>>>(
      load: () => local.list(Kind.coachNote, playerId: playerId, descending: true),
      builder: (context, notes) {
        if (notes.isEmpty) return const EmptyState('Feedback your coach shares will appear here.', icon: Icons.sports_cricket);
        final text = Theme.of(context).textTheme;
        return ListView(padding: const EdgeInsets.fromLTRB(0, 4, 0, 24), children: [
          for (final n in notes)
            Card(
              margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Avatar((n['coachName'] as String?) ?? 'Coach', size: 34),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text((n['coachName'] as String?) ?? 'Coach', style: text.titleSmall),
                        if (n['createdAt'] != null) Text(formatDay(n['createdAt'] as String), style: text.bodySmall),
                      ]),
                    ),
                  ]),
                  for (final (k, label) in const [('technicalCorrections', 'Technical'), ('followUpDrills', 'Drills to do'), ('nextTargets', 'Next targets'), ('mentalSkills', 'Mindset'), ('fitness', 'Fitness')])
                    if (n[k] != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 10),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(label.toUpperCase(), style: text.labelSmall?.copyWith(color: Theme.of(context).colorScheme.primary, letterSpacing: 0.8, fontWeight: FontWeight.w700)),
                          const SizedBox(height: 2),
                          Text('${n[k]}'),
                        ]),
                      ),
                ]),
              ),
            ),
        ]);
      },
    );
  }
}

class _Progress extends StatelessWidget {
  const _Progress({required this.playerId});
  final String playerId;

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return OnlineLoader<(Map<String, dynamic>, List<dynamic>)>(
      key: ValueKey(playerId),
      load: () async => (
        await api.get('/v1/players/$playerId/attendance') as Map<String, dynamic>,
        await api.get('/v1/players/$playerId/packages') as List<dynamic>,
      ),
      builder: (context, data, _) {
        final (attendance, packages) = data;
        final s = attendance['summary'] as Map<String, dynamic>;
        final active = packages.cast<Map<String, dynamic>>().where((p) => p['status'] == 'active').toList();
        final records = (attendance['records'] as List).cast<Map<String, dynamic>>();
        return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
          if (active.isNotEmpty) const SectionHeader('Packages', padding: EdgeInsets.fromLTRB(16, 8, 16, 6)),
          for (final p in active) Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: PackageCard(p)),
          const SectionHeader('Attendance'),
          StatGrid(children: [
            StatTile(label: 'Present', value: '${s['present']}', icon: Icons.check_circle_outline),
            StatTile(label: 'Late', value: '${s['late']}', icon: Icons.schedule, tone: 'warn'),
            StatTile(label: 'Absent', value: '${s['absent']}', icon: Icons.cancel_outlined, tone: 'bad'),
            StatTile(label: 'Excused', value: '${s['excused']}', icon: Icons.event_busy_outlined, tone: 'accent'),
          ]),
          if (records.isNotEmpty) ...[
            const SectionHeader('Recent sessions'),
            GroupCard(children: [
              for (final r in records)
                ListTile(
                  dense: true,
                  title: Text((r['title'] as String?) ?? humanise(r['session_type'] as String)),
                  subtitle: Text(formatWhen(r['starts_at'] as String)),
                  trailing: _attendancePill(context, r),
                ),
            ]),
          ],
        ]);
      },
    );
  }
}

Widget _attendancePill(BuildContext context, Map<String, dynamic> r) {
  if (r['session_status'] == 'cancelled') return Pill.tone(context, 'Cancelled', 'neutral');
  final status = r['status'] as String?;
  return Pill.tone(context, humanise(status ?? 'not recorded'), switch (status) { 'present' => 'good', 'late' => 'warn', 'absent' => 'bad', _ => 'neutral' });
}

class _GuardianApprovals extends StatelessWidget {
  const _GuardianApprovals();

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return OnlineLoader<List<dynamic>>(
      load: () async => ((await api.get('/v1/bookings?status=pending')) as List).where((b) => (b['approvals_needed'] as List).contains('guardian')).toList(),
      builder: (context, items, reload) {
        if (items.isEmpty) return const EmptyState('No requests need your approval.', icon: Icons.how_to_reg_outlined);
        return ListView(padding: const EdgeInsets.only(top: 4), children: [
          for (final b in items.cast<Map<String, dynamic>>())
            Card(margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4), child: ListTile(
              title: Text('${b['player_name']}: ${b['title'] ?? humanise(b['session_type'] as String)}'),
              subtitle: Text(formatWhen(b['starts_at'] as String)),
              trailing: Wrap(children: [
                IconButton(
                  tooltip: 'Decline',
                  icon: const Icon(Icons.close),
                  onPressed: () async {
                    try {
                      await api.post('/v1/bookings/${b['id']}/reject', {'reason': 'Declined by parent'});
                      await reload();
                    } catch (e) {
                      if (context.mounted) showMessage(context, e);
                    }
                  },
                ),
                IconButton(
                  tooltip: 'Approve',
                  icon: const Icon(Icons.check),
                  onPressed: () async {
                    try {
                      final r = await api.post('/v1/bookings/${b['id']}/approve');
                      if (context.mounted) showMessage(context, r['status'] == 'pending' ? 'Approved. The academy will confirm.' : 'Approved: ${humanise(r['status'] as String)}');
                      await reload();
                    } catch (e) {
                      if (context.mounted) showMessage(context, e);
                    }
                  },
                ),
              ]),
            )),
        ]);
      },
    );
  }
}
