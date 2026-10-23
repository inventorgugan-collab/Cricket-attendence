import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import 'widgets.dart';

class NotificationsScreen extends StatelessWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return OnlineLoader<List<dynamic>>(
      load: () async {
        final items = await api.get('/v1/notifications') as List<dynamic>;
        await api.post('/v1/notifications/read', {});
        return items;
      },
      builder: (context, items, _) {
        if (items.isEmpty) return const EmptyState('No notifications yet.');
        return ListView.separated(
          itemCount: items.length,
          separatorBuilder: (_, _) => const Divider(height: 1),
          itemBuilder: (context, i) {
            final n = items[i] as Map<String, dynamic>;
            return ListTile(
              leading: Icon(n['read_at'] == null ? Icons.circle : Icons.circle_outlined, size: 12),
              title: Text(n['title'] as String),
              subtitle: Text('${n['body']}\n${formatWhen(n['created_at'] as String)}'),
              isThreeLine: true,
            );
          },
        );
      },
    );
  }
}
