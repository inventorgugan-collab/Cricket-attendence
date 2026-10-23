import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/sync_service.dart';
import '../common/widgets.dart';

/// Open sessions a player can ask for. Availability is only ever shown from
/// the server; the app never claims a place is free while offline.
class AvailableSessionsScreen extends StatelessWidget {
  const AvailableSessionsScreen({super.key, required this.playerId});
  final String playerId;

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return Scaffold(
      appBar: AppBar(title: const Text('Open group sessions')),
      body: OnlineLoader<List<dynamic>>(
        load: () async => await api.get('/v1/sessions/available?playerId=$playerId') as List<dynamic>,
        builder: (context, sessions, reload) {
          if (sessions.isEmpty) return const EmptyState('No open sessions right now.');
          return ListView(children: [
            for (final s in sessions.cast<Map<String, dynamic>>())
              ListTile(
                title: Text(sessionLabel(s)),
                subtitle: Text('${formatWhen(s['starts_at'] as String)}\n'
                    '${s['places_left'] > 0 ? '${s['places_left']} place${s['places_left'] == 1 ? '' : 's'} left' : 'Full: you can join the waitlist'}'
                    '${(s['coaches'] as List).isEmpty ? '' : ' · ${(s['coaches'] as List).map((c) => c['full_name']).join(', ')}'}'),
                isThreeLine: true,
                trailing: FilledButton.tonal(
                  onPressed: () => _request(context, s, reload),
                  child: Text(s['places_left'] > 0 ? 'Request' : 'Waitlist'),
                ),
              ),
          ]);
        },
      ),
    );
  }

  Future<void> _request(BuildContext context, Map<String, dynamic> s, Future<void> Function() reload) async {
    final api = context.read<ApiClient>();
    try {
      final b = await api.post('/v1/bookings', {'sessionId': s['id'], 'playerId': playerId}) as Map<String, dynamic>;
      final msg = switch (b['status']) {
        'confirmed' => 'Booked and confirmed.',
        'waitlisted' => 'You\'re on the waitlist (number ${b['waitlist_position']}).',
        _ => (b['approvals_needed'] as List).contains('guardian')
            ? 'Request sent. A parent needs to approve it.'
            : 'Request sent. The academy will review it.',
      };
      if (!context.mounted) return;
      showMessage(context, msg);
      await context.read<SyncService>().sync();
      await reload();
    } on OfflineException {
      // Lost signal between loading and tapping: queue it as a request only.
      if (!context.mounted) return;
      await context.read<SyncService>().requestBooking(sessionId: s['id'] as String, playerId: playerId);
      if (context.mounted) showMessage(context, 'No connection. Your request is saved and will be sent; it is not confirmed yet.');
    } on ApiException catch (e) {
      if (context.mounted) showMessage(context, e.message);
    }
  }
}
