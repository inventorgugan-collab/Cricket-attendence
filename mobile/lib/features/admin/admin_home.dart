import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/app_state.dart';
import '../common/notifications_screen.dart';
import '../common/requests_list.dart';
import '../common/widgets.dart';
import '../../ui/components.dart';
import 'admin_forms.dart';
import 'money_screens.dart';
import 'setup_screens.dart';

/// Admin tools on the phone. These need a connection; the admin's job is
/// approvals, corrections and oversight rather than work at the nets.
class AdminHome extends StatefulWidget {
  const AdminHome({super.key});
  @override
  State<AdminHome> createState() => _AdminHomeState();
}

class _AdminHomeState extends State<AdminHome> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final tabs = <(String, String, IconData, IconData, Widget)>[
      ('Today', 'Today', Icons.dashboard_outlined, Icons.dashboard, const _Dashboard()),
      ('Booking requests', 'Requests', Icons.how_to_reg_outlined, Icons.how_to_reg, const _Approvals()),
      ('Players', 'Players', Icons.groups_outlined, Icons.groups, const _Players()),
      ('Money', 'Money', Icons.account_balance_wallet_outlined, Icons.account_balance_wallet, const MoneyTab()),
      ('Notifications', 'Alerts', Icons.notifications_outlined, Icons.notifications, const NotificationsScreen()),
    ];
    return Scaffold(
      appBar: AppBar(title: Text(tabs[_tab].$1), actions: [
        IconButton(
          tooltip: 'Academy setup',
          icon: const Icon(Icons.settings_outlined),
          onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SetupScreen())),
        ),
        IconButton(tooltip: 'Sign out', icon: const Icon(Icons.logout), onPressed: () => context.read<AppState>().signOut()),
      ]),
      body: tabs[_tab].$5,
      floatingActionButton: switch (_tab) {
        0 => FloatingActionButton.extended(
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const NewSessionScreen())),
            icon: const Icon(Icons.add),
            label: const Text('New session'),
          ),
        2 => FloatingActionButton.extended(
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const NewPlayerScreen())),
            icon: const Icon(Icons.person_add),
            label: const Text('Register player'),
          ),
        _ => null,
      },
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [for (final t in tabs) NavigationDestination(icon: Icon(t.$3), selectedIcon: Icon(t.$4), label: t.$2)],
      ),
    );
  }
}

class _Dashboard extends StatelessWidget {
  const _Dashboard();

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    final app = context.read<AppState>();
    return OnlineLoader<Map<String, dynamic>>(
      load: () async => await api.get('/v1/dashboard') as Map<String, dynamic>,
      builder: (context, d, reload) {
        final sessions = (d['sessionsToday'] as List).cast<Map<String, dynamic>>();
        final cover = (d['sessionsNeedingCover'] as List).cast<Map<String, dynamic>>();
        final onLeave = (d['coachesOnLeaveToday'] as List).cast<Map<String, dynamic>>();
        final scheme = Theme.of(context).colorScheme;
        final text = Theme.of(context).textTheme;
        final missing = (d['sessionsAwaitingAttendance'] as List).cast<Map<String, dynamic>>();
        final inactive = (d['inactivePlayers'] as List).cast<Map<String, dynamic>>();
        final conflicts = d['openSyncConflicts'] as int;
        void open(Widget w) async {
          await Navigator.of(context).push(MaterialPageRoute(builder: (_) => w));
          await reload();
        }

        return ListView(padding: const EdgeInsets.only(bottom: 96), children: [
          HeroHeader(
            eyebrow: app.academyName,
            title: greeting(),
            subtitle: formatDay(DateTime.now().toIso8601String()),
            stats: [
              ('${sessions.where((s) => s['status'] != 'cancelled').length}', 'sessions'),
              ('${d['presentToday']}/${d['expectedToday']}', 'players in'),
              ('${d['coachesScheduledToday']}', 'coaches'),
            ],
          ),
          if (cover.isNotEmpty)
            Card(
              margin: const EdgeInsets.fromLTRB(12, 4, 12, 4),
              color: scheme.errorContainer,
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 2),
                  child: Row(children: [
                    Icon(Icons.warning_amber_rounded, color: scheme.onErrorContainer),
                    const SizedBox(width: 8),
                    Text('${cover.length} session${cover.length == 1 ? ' needs' : 's need'} a coach', style: text.titleMedium?.copyWith(color: scheme.onErrorContainer)),
                  ]),
                ),
                for (final c in cover)
                  ListTile(
                    textColor: scheme.onErrorContainer,
                    title: Text('${dayLabel(c['starts_at'] as String)} ${formatTime(c['starts_at'] as String)} · ${sessionLabel(c)}'),
                    subtitle: Text('${c['coach_name']}: ${c['leave_kind'] == 'emergency' ? 'emergency leave' : 'on leave'}${c['leave_reason'] == null ? '' : ' (${c['leave_reason']})'} · ${c['players']} player${c['players'] == 1 ? '' : 's'}'),
                    trailing: FilledButton(
                      style: FilledButton.styleFrom(backgroundColor: scheme.error, foregroundColor: scheme.onError, minimumSize: const Size(0, 38)),
                      onPressed: () => open(ReassignCoachScreen(session: c, replacingCoachId: c['coach_id'] as String)),
                      child: const Text('Reassign'),
                    ),
                  ),
              ]),
            ),
          if (onLeave.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
              child: Wrap(spacing: 6, runSpacing: 6, children: [
                for (final l in onLeave)
                  Pill.tone(context, '${l['coach_name']} on ${l['kind'] == 'emergency' ? 'emergency ' : ''}leave today', l['kind'] == 'emergency' ? 'bad' : 'warn',
                      icon: l['kind'] == 'emergency' ? Icons.warning_amber : Icons.beach_access),
              ]),
            ),
          const SectionHeader('Needs you'),
          StatGrid(children: [
            StatTile(label: 'Requests to confirm', value: '${d['bookingRequestsAwaitingApproval']}', icon: Icons.how_to_reg_outlined, tone: (d['bookingRequestsAwaitingApproval'] as int) > 0 ? 'warn' : null),
            StatTile(label: 'Registers not done', value: '${missing.length}', icon: Icons.fact_check_outlined, tone: missing.isNotEmpty ? 'warn' : null),
            StatTile(label: 'Cancelled today', value: '${d['cancellationsToday']}', icon: Icons.event_busy_outlined, tone: 'accent'),
            StatTile(
              label: 'Offline conflicts',
              value: '$conflicts',
              icon: Icons.call_split,
              tone: conflicts > 0 ? 'bad' : null,
              onTap: () => open(const ConflictsScreen()),
            ),
          ]),
          SectionHeader("Today's sessions", trailing: Text('${sessions.length}', style: text.labelLarge)),
          if (sessions.isEmpty) const Padding(padding: EdgeInsets.fromLTRB(16, 4, 16, 8), child: Text('No sessions today.')),
          for (final s in sessions)
            SessionCard(
              session: s,
              lines: [(s['coaches'] as List).join(', ')],
              badges: [if (s['status'] == 'cancelled') Pill.tone(context, 'Cancelled', 'bad')],
              trailing: s['status'] == 'cancelled'
                  ? null
                  : Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
                      Text('${s['present'] + s['late']}/${s['expected']}', style: text.titleMedium),
                      Text('in', style: text.bodySmall),
                    ]),
            ),
          if (missing.isNotEmpty) ...[
            const SectionHeader('Attendance not completed'),
            GroupCard(children: [
              for (final m in missing)
                ListTile(
                  leading: Icon(Icons.fact_check_outlined, color: scheme.secondary),
                  title: Text(sessionLabel(m)),
                  subtitle: Text('${formatWhen(m['starts_at'] as String)} · ${(m['coaches'] as List).join(', ')} · ${m['players_missing']} not marked'),
                ),
            ]),
          ],
          if (inactive.isNotEmpty) ...[
            const SectionHeader('Not attended recently'),
            GroupCard(children: [
              for (final p in inactive.take(20))
                ListTile(
                  dense: true,
                  leading: Avatar(p['full_name'] as String, size: 32),
                  title: Text(p['full_name'] as String),
                  trailing: Text(p['last_attended'] == null ? 'Never' : formatDay(p['last_attended'] as String), style: text.bodySmall),
                ),
            ]),
          ],
        ]);
      },
    );
  }
}

class _Approvals extends StatelessWidget {
  const _Approvals();

  @override
  Widget build(BuildContext context) => const StaffRequestsList(emptyText: 'No booking requests waiting.');
}

class _Players extends StatelessWidget {
  const _Players();

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return OnlineLoader<List<dynamic>>(
      load: () async => await api.get('/v1/players?status=active') as List<dynamic>,
      builder: (context, players, reload) {
        if (players.isEmpty) return const EmptyState('No players registered yet.', icon: Icons.groups_outlined);
        return ListView(padding: const EdgeInsets.fromLTRB(0, 4, 0, 96), children: [
          GroupCard(children: [
            for (final p in players.cast<Map<String, dynamic>>())
              ListTile(
                leading: Avatar(p['full_name'] as String),
                title: Text(p['full_name'] as String),
                subtitle: Text('${humanise(p['primary_role'] as String?)} · Age ${p['age']}${p['is_minor'] == true ? ' (minor)' : ''}${p['has_account'] == true ? '' : ' · no login yet'}'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => AdminPlayerScreen(playerId: p['id'] as String))),
              ),
          ]),
        ]);
      },
    );
  }
}

/// Changes made offline that clashed with someone else's, for the admin to settle.
class ConflictsScreen extends StatelessWidget {
  const ConflictsScreen({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text('Offline conflicts')), body: const _Conflicts());
}

class _Conflicts extends StatelessWidget {
  const _Conflicts();

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return OnlineLoader<List<dynamic>>(
      load: () async => await api.get('/v1/sync/conflicts') as List<dynamic>,
      builder: (context, items, reload) {
        if (items.isEmpty) return const EmptyState('No offline changes are waiting for a decision.', icon: Icons.check_circle_outline);
        return ListView(children: [
          for (final c in items.cast<Map<String, dynamic>>())
            Card(
              margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${humanise(c['entity'] as String)} from ${c['user_name']}', style: Theme.of(context).textTheme.titleSmall),
                  Text('Made offline ${formatWhen(c['client_time'] as String)}. ${c['reason']}'),
                  const SizedBox(height: 6),
                  Text('Device wanted: ${_summary(c['client_data'])}'),
                  Text('Server has: ${_summary(c['server_data'])}'),
                  Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                    TextButton(onPressed: () => _resolve(context, c['id'] as String, 'server', reload), child: const Text('Keep server')),
                    FilledButton.tonal(onPressed: () => _resolve(context, c['id'] as String, 'client', reload), child: const Text('Use device version')),
                  ]),
                ]),
              ),
            ),
        ]);
      },
    );
  }

  String _summary(Object? data) {
    if (data is! Map) return '-';
    if (data['status'] != null) return humanise(data['status'] as String);
    return (data['technicalCorrections'] ?? data['objectives'] ?? data['skills'] ?? 'edited text').toString();
  }

  Future<void> _resolve(BuildContext context, String id, String keep, Future<void> Function() reload) async {
    try {
      await context.read<ApiClient>().post('/v1/sync/conflicts/$id/resolve', {'keep': keep});
      await reload();
    } catch (e) {
      if (context.mounted) showMessage(context, e);
    }
  }
}
