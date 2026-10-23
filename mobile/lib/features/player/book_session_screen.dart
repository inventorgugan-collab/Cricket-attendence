import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/sync_service.dart';
import '../common/widgets.dart';
import 'available_sessions_screen.dart';

final _ymd = DateFormat('yyyy-MM-dd');

/// Ask for a one-on-one (or other requestable session) at a time that suits
/// the family. Only times when a coach is free are offered; the academy or the
/// coach then confirms. Needs a connection, since free times change constantly.
class BookSessionScreen extends StatefulWidget {
  const BookSessionScreen({super.key, required this.playerId});
  final String playerId;
  @override
  State<BookSessionScreen> createState() => _BookSessionScreenState();
}

class _BookSessionScreenState extends State<BookSessionScreen> {
  List<Map<String, dynamic>>? _categories;
  Map<String, dynamic>? _category;
  DateTime _day = DateTime.now().add(const Duration(days: 1));
  Object? _error;
  int _refresh = 0;

  @override
  void initState() {
    super.initState();
    _loadCategories();
  }

  Future<void> _loadCategories() async {
    try {
      final all = (await context.read<ApiClient>().get('/v1/categories') as List).cast<Map<String, dynamic>>();
      final requestable = all.where((c) => c['requestable'] == true).toList();
      setState(() {
        _categories = requestable;
        _category = requestable.isEmpty ? null : requestable.first;
        _error = null;
      });
    } catch (e) {
      setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cats = _categories;
    return Scaffold(
      appBar: AppBar(title: const Text('Book a session')),
      body: _error != null
          ? Center(child: Text(_error is OfflineException ? 'Booking needs a connection to the academy.' : '$_error'))
          : cats == null
              ? const Center(child: CircularProgressIndicator())
              : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                    child: Wrap(spacing: 8, children: [
                      for (final c in cats)
                        ChoiceChip(label: Text(c['name'] as String), selected: _category?['id'] == c['id'], onSelected: (_) => setState(() => _category = c)),
                    ]),
                  ),
                  SizedBox(
                    height: 72,
                    child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 12), children: [
                      for (var i = 0; i < 21; i++) _dayChip(DateTime.now().add(Duration(days: i))),
                    ]),
                  ),
                  const Divider(height: 1),
                  Expanded(
                    child: _category == null
                        ? const EmptyState('The academy has not opened any sessions for booking yet.')
                        : OnlineLoader<Map<String, dynamic>>(
                            key: ValueKey('${_category!['id']}-${_ymd.format(_day)}-$_refresh'),
                            load: () async => await context.read<ApiClient>().get(
                                '/v1/session-requests/slots?playerId=${widget.playerId}&categoryId=${_category!['id']}&date=${_ymd.format(_day)}') as Map<String, dynamic>,
                            builder: (context, data, _) {
                              final slots = (data['slots'] as List).cast<Map<String, dynamic>>();
                              if (slots.isEmpty) return EmptyState((data['message'] as String?) ?? 'No free times on this day. Try another day.');
                              return ListView(children: [
                                Padding(
                                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                                  child: Text('${data['minutes']} minutes · pick a start time', style: Theme.of(context).textTheme.labelLarge),
                                ),
                                for (final s in slots)
                                  ListTile(
                                    leading: const Icon(Icons.schedule),
                                    title: Text('${formatTime(s['startsAt'] as String)} to ${formatTime(s['endsAt'] as String)}'),
                                    subtitle: Text((s['coaches'] as List).map((c) => c['full_name']).join(', ')),
                                    trailing: const Icon(Icons.chevron_right),
                                    onTap: () => _confirm(s),
                                  ),
                              ]);
                            },
                          ),
                  ),
                  SafeArea(
                    top: false,
                    child: TextButton(
                      onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => AvailableSessionsScreen(playerId: widget.playerId))),
                      child: const Text('Or join an open group session'),
                    ),
                  ),
                ]),
    );
  }

  Widget _dayChip(DateTime d) {
    final selected = _ymd.format(d) == _ymd.format(_day);
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => setState(() => _day = d),
        child: Ink(
          width: 52,
          decoration: BoxDecoration(color: selected ? scheme.primary : scheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(12)),
          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            Text(DateFormat('EEE').format(d), style: TextStyle(fontSize: 12, color: selected ? scheme.onPrimary : null)),
            Text('${d.day}', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 18, color: selected ? scheme.onPrimary : null)),
          ]),
        ),
      ),
    );
  }

  Future<void> _confirm(Map<String, dynamic> slot) async {
    final coaches = (slot['coaches'] as List).cast<Map<String, dynamic>>();
    String? coachId;
    final note = TextEditingController();
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) => Padding(
          padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${_category!['name']}', style: Theme.of(ctx).textTheme.titleLarge),
            Text('${formatDay(slot['startsAt'] as String)}, ${formatTime(slot['startsAt'] as String)} to ${formatTime(slot['endsAt'] as String)}'),
            const SizedBox(height: 16),
            Text('Coach', style: Theme.of(ctx).textTheme.labelLarge),
            RadioGroup<String?>(
              groupValue: coachId,
              onChanged: (v) => set(() => coachId = v),
              child: Column(children: [
                const RadioListTile<String?>(value: null, title: Text('Any free coach'), subtitle: Text('The academy picks'), contentPadding: EdgeInsets.zero),
                for (final c in coaches) RadioListTile<String?>(value: c['id'] as String, title: Text(c['full_name'] as String), contentPadding: EdgeInsets.zero),
              ]),
            ),
            TextField(controller: note, decoration: const InputDecoration(labelText: 'What to work on (optional)', border: OutlineInputBorder())),
            const SizedBox(height: 16),
            SizedBox(width: double.infinity, child: FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Send request'))),
          ]),
        ),
      ),
    );
    if (ok != true || !mounted) return;
    try {
      final r = await context.read<ApiClient>().post('/v1/session-requests', {
        'playerId': widget.playerId,
        'categoryId': _category!['id'],
        'startsAt': slot['startsAt'],
        'coachId': ?coachId,
        if (note.text.trim().isNotEmpty) 'note': note.text.trim(),
      }) as Map<String, dynamic>;
      if (!mounted) return;
      final needsParent = (r['booking']['approvals_needed'] as List).contains('guardian');
      showMessage(context, 'Request sent to ${r['coach']['full_name']}. ${needsParent ? 'A parent needs to approve it first.' : 'You will be told when it is confirmed.'}');
      await context.read<SyncService>().sync();
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) showMessage(context, e);
      setState(() => _refresh++); // someone may have taken that time
    }
  }
}
