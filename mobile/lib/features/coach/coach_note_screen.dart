import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:uuid/uuid.dart';

import '../../core/local_db.dart';
import '../../core/sync_service.dart';
import '../common/widgets.dart';

const _fields = [
  ('objectives', 'Session objectives'),
  ('drillsCompleted', 'Drills completed'),
  ('technicalCorrections', 'Technical corrections'),
  ('tacticalAwareness', 'Tactical awareness'),
  ('matchSimulation', 'Match simulation'),
  ('mentalSkills', 'Mental skills and confidence'),
  ('fitness', 'Fitness and conditioning'),
  ('followUpDrills', 'Follow-up drills'),
  ('nextTargets', 'Next-session targets'),
];

/// A coach's observations for a session, or for one player in it. Separate
/// from the player's own journal; both link to the same session.
class CoachNoteScreen extends StatefulWidget {
  const CoachNoteScreen({super.key, this.sessionId, this.playerId, this.playerName});
  final String? sessionId;
  final String? playerId;
  final String? playerName;

  @override
  State<CoachNoteScreen> createState() => _CoachNoteScreenState();
}

class _CoachNoteScreenState extends State<CoachNoteScreen> {
  final _controllers = {for (final f in _fields) f.$1: TextEditingController()};
  Map<String, dynamic>? _existing;
  bool _shared = false;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final local = context.read<LocalDb>();
    final notes = await local.list(Kind.coachNote, sessionId: widget.sessionId, playerId: widget.playerId);
    final mine = notes.where((n) => n['playerId'] == widget.playerId && n['deleted'] != true).toList();
    if (mine.isNotEmpty) {
      _existing = mine.last;
      for (final f in _fields) {
        _controllers[f.$1]!.text = (_existing![f.$1] as String?) ?? '';
      }
      _shared = _existing!['sharedWithPlayer'] == true;
    }
    setState(() => _loaded = true);
  }

  Future<void> _save() async {
    final note = <String, dynamic>{
      'id': _existing?['id'] ?? const Uuid().v4(),
      'sessionId': widget.sessionId,
      'playerId': widget.playerId,
      'sharedWithPlayer': widget.playerId != null && _shared,
      for (final f in _fields) f.$1: _controllers[f.$1]!.text.trim().isEmpty ? null : _controllers[f.$1]!.text.trim(),
    };
    await context.read<SyncService>().saveCoachNote({...?_existing, ...note});
    if (mounted) {
      showMessage(context, 'Saved on this phone. It will sync automatically.');
      Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.playerName == null ? 'Session notes' : 'Notes: ${widget.playerName}')),
      body: !_loaded
          ? const Center(child: CircularProgressIndicator())
          : ListView(padding: const EdgeInsets.all(16), children: [
              for (final f in _fields) ...[
                TextField(controller: _controllers[f.$1], minLines: 1, maxLines: 5, decoration: InputDecoration(labelText: f.$2, border: const OutlineInputBorder())),
                const SizedBox(height: 12),
              ],
              if (widget.playerId != null)
                SwitchListTile(
                  value: _shared,
                  onChanged: (v) => setState(() => _shared = v),
                  title: const Text('Share with player and parents'),
                  subtitle: const Text('Only shared notes are visible to them.'),
                ),
              const SizedBox(height: 12),
              FilledButton(onPressed: _save, child: const Text('Save')),
            ]),
    );
  }
}
