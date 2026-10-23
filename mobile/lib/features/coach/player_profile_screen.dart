import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/local_db.dart';
import '../common/widgets.dart';

/// A coach's offline view of a player: cricket profile, emergency contacts and
/// current safety restrictions.
class PlayerProfileScreen extends StatelessWidget {
  const PlayerProfileScreen({super.key, required this.playerId});
  final String playerId;

  @override
  Widget build(BuildContext context) {
    final local = context.read<LocalDb>();
    return LocalBuilder<(Map<String, dynamic>?, List<Map<String, dynamic>>, List<Map<String, dynamic>>)>(
      load: () async => (
        await local.get(Kind.player, playerId),
        await local.list(Kind.injury, playerId: playerId),
        await local.list(Kind.coachNote, playerId: playerId, descending: true),
      ),
      builder: (context, data) {
        final (p, injuries, notes) = data;
        if (p == null) return Scaffold(appBar: AppBar(), body: const EmptyState('Player not available offline.'));
        Widget row(String label, Object? value) =>
            value == null || '$value'.isEmpty ? const SizedBox.shrink() : ListTile(dense: true, title: Text(label), subtitle: Text(humanise('$value')));
        return Scaffold(
          appBar: AppBar(title: Text(p['full_name'] as String)),
          body: ListView(children: [
            if (injuries.isNotEmpty) ...[
              const _Header('Safety information'),
              for (final i in injuries)
                ListTile(
                  leading: Icon(Icons.healing, color: i['is_current'] == true ? Theme.of(context).colorScheme.error : null),
                  title: Text('${i['title']} (${i['severity']}${i['is_current'] == true ? ', current' : ''})'),
                  subtitle: Text([
                    if (i['professional_restrictions'] != null) 'Restrictions: ${i['professional_restrictions']}',
                    if (i['recovery_status'] != null) 'Recovery: ${i['recovery_status']}',
                    if (i['follow_up_date'] != null) 'Follow up: ${i['follow_up_date']}',
                  ].join('\n')),
                ),
            ],
            const _Header('Cricket profile'),
            row('Age', p['age']),
            row('Primary role', p['primary_role']),
            row('Batting', p['batting_style']),
            row('Batting position', p['batting_position']),
            row('Bowling arm', p['bowling_arm']),
            row('Bowling style', p['bowling_style']),
            row('Level', p['playing_level']),
            row('Goals', p['development_goals']),
            const _Header('Emergency contacts'),
            row('Emergency contact', [p['emergency_name'], p['emergency_relationship'], p['emergency_phone']].whereType<String>().join(' · ')),
            row('Father', [p['father_name'], p['father_phone']].whereType<String>().join(' · ')),
            row('Mother', [p['mother_name'], p['mother_phone']].whereType<String>().join(' · ')),
            row('Player phone', p['phone']),
            if (notes.isNotEmpty) const _Header('Your recent notes'),
            for (final n in notes.take(10))
              ListTile(
                title: Text((n['technicalCorrections'] ?? n['nextTargets'] ?? n['objectives'] ?? 'Note') as String, maxLines: 2, overflow: TextOverflow.ellipsis),
                subtitle: Text(n['createdAt'] == null ? 'Not yet synced' : formatDay(n['createdAt'] as String)),
              ),
          ]),
        );
      },
    );
  }
}

class _Header extends StatelessWidget {
  const _Header(this.text);
  final String text;
  @override
  Widget build(BuildContext context) =>
      Padding(padding: const EdgeInsets.fromLTRB(16, 20, 16, 4), child: Text(text, style: Theme.of(context).textTheme.titleSmall));
}
