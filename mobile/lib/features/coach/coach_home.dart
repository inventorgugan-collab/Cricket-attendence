import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/app_state.dart';
import '../../core/local_db.dart';
import '../../core/sync_service.dart';
import '../common/notifications_screen.dart';
import '../common/requests_list.dart';
import '../../ui/components.dart';
import '../common/widgets.dart';
import 'leave_screen.dart';
import 'player_profile_screen.dart';
import 'session_register_screen.dart';

class CoachHome extends StatefulWidget {
  const CoachHome({super.key});
  @override
  State<CoachHome> createState() => _CoachHomeState();
}

class _CoachHomeState extends State<CoachHome> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    return Scaffold(
      appBar: AppBar(
        title: Text(['Schedule', 'Requests', 'My players', 'Notifications'][_tab]),
        actions: [
          IconButton(tooltip: 'Sync now', onPressed: () => context.read<SyncService>().sync(), icon: const Icon(Icons.sync)),
          PopupMenuButton<String>(
            onSelected: (v) => v == 'leave'
                ? Navigator.of(context).push(MaterialPageRoute(builder: (_) => LeaveScreen(coachId: app.profileId)))
                : _confirmSignOut(context),
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'leave', child: Text('My leave')),
              PopupMenuItem(value: 'out', child: Text('Sign out ${app.user?['displayName'] ?? ''}')),
            ],
          ),
        ],
      ),
      body: Column(children: [
        if (_tab != 0) const SyncBanner(),
        Expanded(
          child: [
            const _Schedule(),
            const StaffRequestsList(emptyText: 'No session requests waiting for you.'),
            const _Players(),
            const NotificationsScreen(),
          ][_tab],
        ),
      ]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.event), label: 'Schedule'),
          NavigationDestination(icon: Icon(Icons.how_to_reg), label: 'Requests'),
          NavigationDestination(icon: Icon(Icons.groups), label: 'Players'),
          NavigationDestination(icon: Icon(Icons.notifications_outlined), label: 'Alerts'),
        ],
      ),
    );
  }
}

Future<void> _confirmSignOut(BuildContext context) async {
  final sync = context.read<SyncService>();
  await sync.refreshCounts();
  if (!context.mounted) return;
  final unsent = sync.pending;
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('Sign out?'),
      content: Text(unsent > 0
          ? '$unsent change${unsent == 1 ? ' has' : 's have'} not reached the server yet and will be lost. Connect to the internet and sync first if you can.'
          : 'Your data on this phone will be removed.'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Stay signed in')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Sign out')),
      ],
    ),
  );
  if (ok == true && context.mounted) await context.read<AppState>().signOut();
}

class _Schedule extends StatelessWidget {
  const _Schedule();

  @override
  Widget build(BuildContext context) {
    final local = context.read<LocalDb>();
    final app = context.read<AppState>();
    return LocalBuilder<List<Map<String, dynamic>>>(
      load: () async {
        final from = DateTime.now().subtract(const Duration(days: 2));
        final sessions = await local.list(Kind.session);
        return sessions.where((s) => DateTime.parse(s['ends_at'] as String).isAfter(from)).toList();
      },
      builder: (context, sessions) {
        final coachId = app.profileId!;
        final now = DateTime.now();
        final today = sessions.where((s) => dayLabel(s['starts_at'] as String) == 'Today' && s['status'] != 'cancelled').toList();
        final next = sessions.where((s) => s['status'] != 'cancelled' && DateTime.parse(s['starts_at'] as String).isAfter(now)).firstOrNull;
        final name = (app.user?['displayName'] as String?) ?? '';
        String? lastDay;
        final children = <Widget>[
          HeroHeader(
            eyebrow: app.academyName,
            title: '${greeting()}${name.isEmpty ? '' : ', ${name.split(' ').first}'}',
            subtitle: next == null ? 'Nothing else on your schedule yet.' : 'Next: ${sessionLabel(next)}, ${dayLabel(next['starts_at'] as String).toLowerCase()} at ${formatTime(next['starts_at'] as String)}',
            stats: [
              ('${today.length}', today.length == 1 ? 'session today' : 'sessions today'),
              ('${sessions.where((s) => s['status'] != 'cancelled' && DateTime.parse(s['starts_at'] as String).isAfter(now)).length}', 'coming up'),
            ],
            action: OutlinedButton.icon(
              style: OutlinedButton.styleFrom(foregroundColor: Colors.white, side: BorderSide(color: Colors.white.withValues(alpha: 0.4)), minimumSize: const Size(0, 40)),
              icon: const Icon(Icons.sick_outlined, size: 18),
              label: const Text("Can't come in today?"),
              onPressed: () => reportEmergency(context, coachId),
            ),
          ),
          const SyncBanner(),
          if (sessions.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Text('No sessions on your schedule. Pull to refresh when you have signal.', textAlign: TextAlign.center)),
        ];
        for (final s in sessions) {
          final day = dayLabel(s['starts_at'] as String);
          if (day != lastDay) {
            children.add(SectionHeader(day));
            lastDay = day;
          }
          children.add(_SessionTile(s));
        }
        children.add(const SizedBox(height: 24));
        return RefreshIndicator(onRefresh: () => context.read<SyncService>().sync(), child: ListView(children: children));
      },
    );
  }
}

class _SessionTile extends StatelessWidget {
  const _SessionTile(this.s);
  final Map<String, dynamic> s;

  @override
  Widget build(BuildContext context) {
    final place = [s['location_name'], s['area_name']].whereType<String>().join(' · ');
    final status = s['status'] as String;
    return SessionCard(
      session: s,
      lines: [place],
      badges: [
        if (s['origin'] == 'request') Pill.tone(context, 'Requested by player', 'accent', icon: Icons.front_hand_outlined),
        if (status == 'cancelled') Pill.tone(context, 'Cancelled', 'bad') else if (status != 'scheduled') Pill.tone(context, humanise(status), 'neutral'),
      ],
      trailing: const Icon(Icons.chevron_right),
      onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => SessionRegisterScreen(sessionId: s['id'] as String))),
    );
  }
}

class _Players extends StatelessWidget {
  const _Players();

  @override
  Widget build(BuildContext context) {
    final local = context.read<LocalDb>();
    return LocalBuilder<List<Map<String, dynamic>>>(
      load: () => local.list(Kind.player),
      builder: (context, players) {
        if (players.isEmpty) return const EmptyState('Players on your sessions appear here after syncing.', icon: Icons.groups_outlined);
        return ListView(padding: const EdgeInsets.only(top: 4, bottom: 24), children: [
          GroupCard(children: [
            for (final p in players)
              ListTile(
                leading: Avatar(p['full_name'] as String),
                title: Text(p['full_name'] as String),
                subtitle: Text([humanise(p['primary_role'] as String?), if (p['age'] != null) 'Age ${p['age']}'].where((x) => x.isNotEmpty).join(' · ')),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => PlayerProfileScreen(playerId: p['id'] as String))),
              ),
          ]),
        ]);
      },
    );
  }
}
