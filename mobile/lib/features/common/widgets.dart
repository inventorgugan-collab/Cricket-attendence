import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/sync_service.dart';
import '../../ui/components.dart';
import 'sync_problems_screen.dart';

final _time = DateFormat('h:mm a');
final _day = DateFormat('EEE d MMM');

String formatTime(String iso) => _time.format(DateTime.parse(iso).toLocal());
String formatDay(String iso) => _day.format(DateTime.parse(iso).toLocal());
String formatWhen(String iso) => '${formatDay(iso)}, ${formatTime(iso)}';

/// "Today", "Tomorrow", "Yesterday", or the date.
String dayLabel(String iso) {
  final d = DateTime.parse(iso).toLocal();
  final now = DateTime.now();
  final diff = DateTime(d.year, d.month, d.day).difference(DateTime(now.year, now.month, now.day)).inDays;
  return switch (diff) { 0 => 'Today', 1 => 'Tomorrow', -1 => 'Yesterday', _ => _day.format(d) };
}

String humanise(String? s) => s == null ? '' : s.replaceAll('_', ' ').replaceFirstMapped(RegExp('^.'), (m) => m[0]!.toUpperCase());

String sessionLabel(Map<String, dynamic> s) => (s['title'] as String?)?.isNotEmpty == true
    ? s['title'] as String
    : (s['category_name'] as String?) ?? humanise(s['session_type'] as String?);

/// Shows whether the user's changes have reached the server. Shown on every
/// home screen so nobody has to guess whether attendance was saved. Quiet when
/// all is well; coloured when something is waiting or wrong.
class SyncBanner extends StatelessWidget {
  const SyncBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final sync = context.watch<SyncService>();
    final scheme = Theme.of(context).colorScheme;
    late final String text;
    late final IconData icon;
    Color? bg;
    var fg = scheme.onSurfaceVariant;
    if (sync.problems > 0) {
      text = '${sync.problems} change${sync.problems == 1 ? '' : 's'} need${sync.problems == 1 ? 's' : ''} your attention';
      icon = Icons.error_outline;
      bg = scheme.errorContainer;
      fg = scheme.onErrorContainer;
    } else if (sync.state == SyncState.syncing) {
      text = 'Syncing…';
      icon = Icons.sync;
    } else if (sync.pending > 0) {
      text = '${sync.pending} change${sync.pending == 1 ? '' : 's'} saved on this phone, waiting to send';
      icon = Icons.cloud_upload_outlined;
      bg = scheme.tertiaryContainer;
      fg = scheme.onTertiaryContainer;
    } else if (sync.state == SyncState.offline) {
      text = 'Offline. Showing what was last synced.';
      icon = Icons.cloud_off;
      bg = scheme.surfaceContainerHighest;
    } else {
      text = sync.lastSyncedAt == null ? 'Not synced yet' : 'Up to date · ${formatTime(sync.lastSyncedAt!.toIso8601String())}';
      icon = Icons.cloud_done_outlined;
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 4),
      child: Material(
        color: bg ?? Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: sync.problems > 0
              ? () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SyncProblemsScreen()))
              : () => sync.sync(),
          child: Padding(
            padding: EdgeInsets.symmetric(horizontal: bg == null ? 4 : 10, vertical: bg == null ? 2 : 8),
            child: Row(children: [
              Icon(icon, size: 15, color: fg),
              const SizedBox(width: 6),
              Expanded(child: Text(text, style: Theme.of(context).textTheme.labelMedium?.copyWith(color: fg))),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Loads data that needs a connection and shows a clear message when offline.
class OnlineLoader<T> extends StatefulWidget {
  const OnlineLoader({super.key, required this.load, required this.builder});
  final Future<T> Function() load;
  final Widget Function(BuildContext context, T data, Future<void> Function() reload) builder;

  @override
  State<OnlineLoader<T>> createState() => _OnlineLoaderState<T>();
}

class _OnlineLoaderState<T> extends State<OnlineLoader<T>> {
  late Future<T> _future = widget.load();

  Future<void> _reload() async {
    setState(() => _future = widget.load());
    await _future.catchError((_) => null as T);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<T>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
        if (snap.hasError) {
          final offline = snap.error is OfflineException;
          return Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Icon(offline ? Icons.cloud_off : Icons.error_outline, size: 40),
                const SizedBox(height: 12),
                Text(offline ? 'This needs a connection to the academy server.' : '${snap.error}', textAlign: TextAlign.center),
                const SizedBox(height: 12),
                OutlinedButton(onPressed: _reload, child: const Text('Try again')),
              ]),
            ),
          );
        }
        return RefreshIndicator(onRefresh: _reload, child: widget.builder(context, snap.data as T, _reload));
      },
    );
  }
}

void showMessage(BuildContext context, Object message) {
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$message')));
}

class EmptyState extends StatelessWidget {
  const EmptyState(this.text, {super.key, this.icon = Icons.inbox_outlined});
  final String text;
  final IconData icon;
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ListView(padding: const EdgeInsets.fromLTRB(32, 56, 32, 32), children: [
      Center(
        child: Container(
          width: 64,
          height: 64,
          decoration: BoxDecoration(color: scheme.primaryContainer, shape: BoxShape.circle),
          child: Icon(icon, size: 30, color: scheme.onPrimaryContainer),
        ),
      ),
      const SizedBox(height: 16),
      Text(text, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyLarge?.copyWith(color: scheme.onSurfaceVariant)),
    ]);
  }
}

class StatusChip extends StatelessWidget {
  const StatusChip(this.status, {super.key});
  final String status;

  @override
  Widget build(BuildContext context) {
    final (label, tone) = switch (status) {
      'confirmed' => ('Confirmed', 'good'),
      'pending' => ('Awaiting approval', 'warn'),
      'queued' => ('Waiting to send', 'neutral'),
      'waitlisted' => ('Waitlisted', 'accent'),
      'rejected' => ('Not accepted', 'bad'),
      'cancelled' => ('Cancelled', 'neutral'),
      'completed' => ('Completed', 'neutral'),
      _ => (humanise(status), 'neutral'),
    };
    return Pill.tone(context, label, tone);
  }
}

/// Reads from the device database and re-reads whenever sync changes anything.
class LocalBuilder<T> extends StatefulWidget {
  const LocalBuilder({super.key, required this.load, required this.builder});
  final Future<T> Function() load;
  final Widget Function(BuildContext context, T data) builder;
  @override
  State<LocalBuilder<T>> createState() => _LocalBuilderState<T>();
}

class _LocalBuilderState<T> extends State<LocalBuilder<T>> {
  T? _data;
  SyncService? _sync;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final sync = context.read<SyncService>();
    if (!identical(sync, _sync)) {
      _sync?.removeListener(_reload);
      _sync = sync..addListener(_reload);
      _reload();
    }
  }

  @override
  void didUpdateWidget(covariant LocalBuilder<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    _reload();
  }

  Future<void> _reload() async {
    final data = await widget.load();
    if (mounted) setState(() => _data = data);
  }

  @override
  void dispose() {
    _sync?.removeListener(_reload);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    if (data == null) return const Center(child: CircularProgressIndicator());
    return widget.builder(context, data);
  }
}
