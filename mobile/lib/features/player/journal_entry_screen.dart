import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:uuid/uuid.dart';

import '../../core/sync_service.dart';
import '../common/widgets.dart';

/// A player's daily training journal. Saved on the phone first; works offline.
class JournalEntryScreen extends StatefulWidget {
  const JournalEntryScreen({super.key, required this.playerId, this.existing});
  final String playerId;
  final Map<String, dynamic>? existing;

  @override
  State<JournalEntryScreen> createState() => _JournalEntryScreenState();
}

class _JournalEntryScreenState extends State<JournalEntryScreen> {
  static const _text = [
    ('skills', 'Skills practised'),
    ('drills', 'Drills performed'),
    ('wentWell', 'What went well'),
    ('toImprove', 'What needs improvement'),
    ('difficulties', 'Difficulties or discomfort'),
    ('reflections', 'Reflections'),
    ('goals', 'Goals'),
  ];
  static const _volume = [('balls', 'Balls'), ('overs', 'Overs'), ('sets', 'Sets'), ('reps', 'Reps')];

  late final Map<String, TextEditingController> _c;
  late DateTime _date;

  @override
  void initState() {
    super.initState();
    final e = widget.existing ?? const {};
    final volume = (e['volume'] as Map?) ?? const {};
    _c = {
      for (final f in _text) f.$1: TextEditingController(text: e[f.$1] as String? ?? ''),
      for (final v in _volume) v.$1: TextEditingController(text: volume[v.$1]?.toString() ?? ''),
    };
    _date = e['entryDate'] != null ? DateTime.parse(e['entryDate'] as String) : DateTime.now();
  }

  Future<void> _save() async {
    String? t(String k) => _c[k]!.text.trim().isEmpty ? null : _c[k]!.text.trim();
    final volume = <String, num>{
      for (final v in _volume)
        if (num.tryParse(_c[v.$1]!.text.trim()) != null) v.$1: v.$1 == 'overs' ? num.parse(_c[v.$1]!.text.trim()) : int.parse(_c[v.$1]!.text.trim()),
    };
    final entry = {
      ...?widget.existing,
      'id': widget.existing?['id'] ?? const Uuid().v4(),
      'playerId': widget.playerId,
      'entryDate': DateFormat('yyyy-MM-dd').format(_date),
      'volume': volume,
      for (final f in _text) f.$1: t(f.$1),
    };
    await context.read<SyncService>().saveJournal(entry);
    if (mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.existing == null ? 'New journal entry' : 'Edit entry')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text('Date: ${DateFormat('EEE d MMM yyyy').format(_date)}'),
          trailing: const Icon(Icons.calendar_today),
          onTap: () async {
            final d = await showDatePicker(context: context, initialDate: _date, firstDate: DateTime(2020), lastDate: DateTime.now());
            if (d != null) setState(() => _date = d);
          },
        ),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final v in _volume)
            SizedBox(
              width: 80,
              child: TextField(controller: _c[v.$1], keyboardType: TextInputType.number, decoration: InputDecoration(labelText: v.$2, border: const OutlineInputBorder())),
            ),
        ]),
        const SizedBox(height: 12),
        for (final f in _text) ...[
          TextField(controller: _c[f.$1], minLines: 1, maxLines: 4, decoration: InputDecoration(labelText: f.$2, border: const OutlineInputBorder())),
          const SizedBox(height: 12),
        ],
        const Text('If something hurts, tell your coach or parent too. The app does not assess injuries.'),
        const SizedBox(height: 12),
        FilledButton(onPressed: _save, child: const Text('Save')),
        if (widget.existing != null) ...[
          const SizedBox(height: 8),
          Text('Last saved ${widget.existing!['updatedAt'] == null ? 'on this phone' : formatWhen(widget.existing!['updatedAt'] as String)}', textAlign: TextAlign.center),
        ],
      ]),
    );
  }
}
