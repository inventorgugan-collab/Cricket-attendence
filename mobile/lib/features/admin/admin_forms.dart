import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../common/package_card.dart';
import '../../ui/components.dart';
import '../common/widgets.dart';
import 'money_screens.dart';

final _ymd = DateFormat('yyyy-MM-dd');

InputDecoration _field(String label) => InputDecoration(labelText: label, border: const OutlineInputBorder());

// ---------------------------------------------------------------------------
// Register a player (only the details the academy actually needs).
// ---------------------------------------------------------------------------

class NewPlayerScreen extends StatefulWidget {
  const NewPlayerScreen({super.key});
  @override
  State<NewPlayerScreen> createState() => _NewPlayerScreenState();
}

class _NewPlayerScreenState extends State<NewPlayerScreen> {
  final _c = {
    for (final k in ['full_name', 'phone', 'city', 'father_name', 'father_phone', 'mother_name', 'mother_phone', 'emergency_name', 'emergency_phone', 'emergency_relationship'])
      k: TextEditingController(),
  };
  DateTime? _dob;
  String? _role;
  bool _busy = false;

  Future<void> _save() async {
    if (_c['full_name']!.text.trim().isEmpty || _dob == null) return showMessage(context, 'Name and date of birth are required');
    setState(() => _busy = true);
    try {
      final body = <String, dynamic>{
        for (final e in _c.entries)
          if (e.value.text.trim().isNotEmpty) e.key: e.value.text.trim(),
        'date_of_birth': _ymd.format(_dob!),
        if (_role != null) 'primary_role': _role,
      };
      final p = await context.read<ApiClient>().post('/v1/players', body) as Map<String, dynamic>;
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => AdminPlayerScreen(playerId: p['id'] as String)));
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _text(String key, String label, {TextInputType? type}) =>
      Padding(padding: const EdgeInsets.only(bottom: 12), child: TextField(controller: _c[key], keyboardType: type, decoration: _field(label)));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Register player')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        _text('full_name', 'Full name'),
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(_dob == null ? 'Date of birth' : 'Born ${DateFormat('d MMM yyyy').format(_dob!)}'),
          trailing: const Icon(Icons.cake_outlined),
          onTap: () async {
            final d = await showDatePicker(context: context, initialDate: DateTime(DateTime.now().year - 12), firstDate: DateTime(1950), lastDate: DateTime.now());
            if (d != null) setState(() => _dob = d);
          },
        ),
        DropdownButtonFormField<String>(
          initialValue: _role,
          decoration: _field('Primary role'),
          items: const [
            DropdownMenuItem(value: 'batter', child: Text('Batter')),
            DropdownMenuItem(value: 'bowler', child: Text('Bowler')),
            DropdownMenuItem(value: 'all_rounder', child: Text('All-rounder')),
            DropdownMenuItem(value: 'wicketkeeper', child: Text('Wicketkeeper')),
            DropdownMenuItem(value: 'other', child: Text('Other')),
          ],
          onChanged: (v) => setState(() => _role = v),
        ),
        const SizedBox(height: 12),
        _text('phone', 'Player phone', type: TextInputType.phone),
        _text('city', 'City'),
        _text('father_name', 'Father\'s name'),
        _text('father_phone', 'Father\'s phone', type: TextInputType.phone),
        _text('mother_name', 'Mother\'s name'),
        _text('mother_phone', 'Mother\'s phone', type: TextInputType.phone),
        _text('emergency_name', 'Emergency contact'),
        _text('emergency_relationship', 'Relationship'),
        _text('emergency_phone', 'Emergency phone', type: TextInputType.phone),
        FilledButton(onPressed: _busy ? null : _save, child: const Text('Register')),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------
// Player detail for admins: guardians, logins and training packages.
// ---------------------------------------------------------------------------

class AdminPlayerScreen extends StatelessWidget {
  const AdminPlayerScreen({super.key, required this.playerId});
  final String playerId;

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return Scaffold(
      appBar: AppBar(title: const Text('Player')),
      body: OnlineLoader<(Map<String, dynamic>, List<dynamic>)>(
        load: () async => (await api.get('/v1/players/$playerId') as Map<String, dynamic>, await api.get('/v1/players/$playerId/packages') as List<dynamic>),
        builder: (context, data, reload) {
          final (p, packages) = data;
          final guardians = (p['guardians'] as List).cast<Map<String, dynamic>>();
          return ListView(padding: const EdgeInsets.all(12), children: [
            Text(p['full_name'] as String, style: Theme.of(context).textTheme.headlineSmall),
            Text('Age ${p['age']}${p['is_minor'] == true ? ' (minor)' : ''} · ${humanise(p['primary_role'] as String?)} · ${humanise(p['status'] as String)}'),
            const SizedBox(height: 8),
            if (p['has_account'] != true)
              OutlinedButton.icon(
                icon: const Icon(Icons.key),
                label: const Text('Create player login'),
                onPressed: () => _createLogin(context, role: 'player', profileId: playerId, name: p['full_name'] as String, reload: reload),
              ),
            const Divider(height: 32),
            Text('Parents and guardians', style: Theme.of(context).textTheme.titleMedium),
            for (final g in guardians)
              ListTile(title: Text(g['full_name'] as String), subtitle: Text('${humanise(g['relationship'] as String)} · ${g['phone'] ?? ''}')),
            TextButton.icon(icon: const Icon(Icons.add), label: const Text('Add parent or guardian'), onPressed: () => _addGuardian(context, reload)),
            const Divider(height: 32),
            Text('Training packages', style: Theme.of(context).textTheme.titleMedium),
            for (final pk in packages.cast<Map<String, dynamic>>())
              PackageCard(pk, onAdjust: pk['status'] == 'active' && pk['kind'] == 'fixed' ? (part) => _adjust(context, pk, part, reload) : null),
            TextButton.icon(
              icon: const Icon(Icons.add),
              label: const Text('Add package'),
              onPressed: () async {
                final added = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => AddPackageScreen(playerId: playerId, playerName: p['full_name'] as String)));
                if (added == true) await reload();
              },
            ),
            // A new key after each reload so a new package's fee shows up.
            PlayerFeesCard(key: ValueKey(packages.length), playerId: playerId, playerName: p['full_name'] as String),
          ]);
        },
      ),
    );
  }

  // Give or take back sessions in one part, with a reason kept on record.
  Future<void> _adjust(BuildContext context, Map<String, dynamic> pk, Map<String, dynamic>? part, Future<void> Function() reload) async {
    var delta = 1;
    final note = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) => AlertDialog(
          title: Text('Adjust ${part?['category_name'] ?? 'sessions'}'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              IconButton(onPressed: () => set(() => delta = delta == 1 ? -1 : delta - 1), icon: const Icon(Icons.remove)),
              Text(delta > 0 ? '+$delta' : '$delta', style: Theme.of(ctx).textTheme.headlineSmall),
              IconButton(onPressed: () => set(() => delta = delta == -1 ? 1 : delta + 1), icon: const Icon(Icons.add)),
            ]),
            TextField(controller: note, decoration: _field('Reason (kept on record)')),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save')),
          ],
        ),
      ),
    );
    if (ok != true || !context.mounted) return;
    try {
      await context.read<ApiClient>().post('/v1/packages/${pk['id']}/adjust', {
        'delta': delta,
        'note': note.text.trim(),
        if (part != null) 'categoryId': part['category_id'],
      });
      await reload();
    } catch (e) {
      if (context.mounted) showMessage(context, e);
    }
  }

  Future<void> _addGuardian(BuildContext context, Future<void> Function() reload) async {
    final name = TextEditingController();
    final phone = TextEditingController();
    final relationship = TextEditingController(text: 'mother');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Add parent or guardian'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: name, decoration: _field('Name')),
          const SizedBox(height: 8),
          TextField(controller: phone, keyboardType: TextInputType.phone, decoration: _field('Phone')),
          const SizedBox(height: 8),
          TextField(controller: relationship, decoration: _field('Relationship')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Add')),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    final api = context.read<ApiClient>();
    try {
      final g = await api.post('/v1/guardians', {'full_name': name.text.trim(), 'phone': phone.text.trim()}) as Map<String, dynamic>;
      await api.post('/v1/players/$playerId/guardians', {'guardianId': g['id'], 'relationship': relationship.text.trim(), 'isPrimary': true});
      if (context.mounted && phone.text.trim().isNotEmpty) {
        await _createLogin(context, role: 'guardian', profileId: g['id'] as String, name: name.text.trim(), reload: reload, suggestedLogin: phone.text.trim());
      }
      await reload();
    } catch (e) {
      if (context.mounted) showMessage(context, e);
    }
  }
}

Future<void> _createLogin(BuildContext context,
    {required String role, required String profileId, required String name, required Future<void> Function() reload, String? suggestedLogin}) async {
  final login = TextEditingController(text: suggestedLogin);
  final password = TextEditingController();
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text('Create login for $name'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: login, decoration: _field('Login (phone or email)')),
        const SizedBox(height: 8),
        TextField(controller: password, decoration: _field('Temporary password (8+ characters)')),
        const SizedBox(height: 8),
        const Text('They will be asked to choose their own password when they first sign in.'),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Create')),
      ],
    ),
  );
  if (ok != true || !context.mounted) return;
  try {
    await context.read<ApiClient>().post('/v1/accounts', {
      'role': role,
      'login': login.text.trim(),
      'temporaryPassword': password.text,
      'displayName': name,
      'profileId': profileId,
    });
    if (context.mounted) showMessage(context, 'Login created');
    await reload();
  } catch (e) {
    if (context.mounted) showMessage(context, e);
  }
}

// ---------------------------------------------------------------------------
// Schedule a session.
// ---------------------------------------------------------------------------

class NewSessionScreen extends StatefulWidget {
  const NewSessionScreen({super.key});
  @override
  State<NewSessionScreen> createState() => _NewSessionScreenState();
}

class _NewSessionScreenState extends State<NewSessionScreen> {
  String _type = 'group';
  String _mode = 'fixed';
  final _title = TextEditingController();
  final _capacity = TextEditingController(text: '12');
  DateTime _date = DateTime.now();
  TimeOfDay _start = const TimeOfDay(hour: 6, minute: 0);
  int _minutes = 90;
  final Set<String> _coaches = {};
  final Set<String> _players = {};
  String? _area;
  String? _category;
  bool _busy = false;

  List<Map<String, dynamic>> _categories = [];

  Future<(List<dynamic>, List<dynamic>, List<dynamic>)> _load() async {
    final api = context.read<ApiClient>();
    _categories = (await api.get('/v1/categories') as List).cast<Map<String, dynamic>>();
    return (await api.get('/v1/coaches') as List, await api.get('/v1/locations') as List, await api.get('/v1/players?status=active') as List);
  }

  Future<void> _save() async {
    if (_coaches.isEmpty) return showMessage(context, 'Choose at least one coach');
    final starts = DateTime(_date.year, _date.month, _date.day, _start.hour, _start.minute);
    setState(() => _busy = true);
    try {
      final r = await context.read<ApiClient>().post('/v1/sessions', {
        'sessionType': _type,
        'categoryId': ?_category,
        'bookingMode': _mode,
        if (_title.text.trim().isNotEmpty) 'title': _title.text.trim(),
        'startsAt': starts.toUtc().toIso8601String(),
        'endsAt': starts.add(Duration(minutes: _minutes)).toUtc().toIso8601String(),
        if (_type == 'group') 'capacity': int.tryParse(_capacity.text) ?? 1,
        'coachIds': _coaches.toList(),
        if (_area != null) 'areaId': _area,
        if (_players.isNotEmpty) 'playerIds': _players.toList(),
      }) as Map<String, dynamic>;
      if (!mounted) return;
      final notes = [
        ...(r['warnings'] as List).cast<String>(),
        for (final s in (r['skippedPlayers'] as List).cast<Map<String, dynamic>>()) 'A player was not added: ${s['reason']}',
      ];
      showMessage(context, notes.isEmpty ? 'Session created' : 'Session created. ${notes.join(' ')}');
      Navigator.of(context).pop();
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final maxPlayers = _type == 'one_on_one' ? 1 : _type == 'one_on_two' ? 2 : null;
    return Scaffold(
      appBar: AppBar(title: const Text('New session')),
      body: OnlineLoader<(List<dynamic>, List<dynamic>, List<dynamic>)>(
        load: _load,
        builder: (context, data, _) {
          final (coaches, locations, players) = data;
          final areas = [
            for (final l in locations.cast<Map<String, dynamic>>())
              for (final a in (l['areas'] as List).cast<Map<String, dynamic>>()) (a['id'] as String, '${l['name']} · ${a['name']}'),
          ];
          return ListView(padding: const EdgeInsets.all(16), children: [
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'group', label: Text('Group')),
                ButtonSegment(value: 'one_on_one', label: Text('1:1')),
                ButtonSegment(value: 'one_on_two', label: Text('1:2')),
              ],
              selected: {_type},
              onSelectionChanged: (s) => setState(() {
                _type = s.first;
                _players.clear();
                _category = null;
              }),
            ),
            if (_categories.where((c) => c['session_type'] == _type && c['active'] == true).length > 1) ...[
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                key: ValueKey(_type),
                initialValue: _category,
                decoration: _field('Kind of session'),
                hint: Text(_categories.firstWhere((c) => c['code'] == _type, orElse: () => {'name': humanise(_type)})['name'] as String),
                items: [
                  for (final c in _categories.where((c) => c['session_type'] == _type && c['active'] == true))
                    DropdownMenuItem(value: c['id'] as String, child: Text(c['name'] as String)),
                ],
                onChanged: (v) => setState(() => _category = v),
              ),
            ],
            const SizedBox(height: 12),
            TextField(controller: _title, decoration: _field('Title (optional)')),
            const SizedBox(height: 12),
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(DateFormat('EEE d MMM yyyy').format(_date)),
              trailing: const Icon(Icons.calendar_today),
              onTap: () async {
                final d = await showDatePicker(context: context, initialDate: _date, firstDate: DateTime.now().subtract(const Duration(days: 7)), lastDate: DateTime.now().add(const Duration(days: 365)));
                if (d != null) setState(() => _date = d);
              },
            ),
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('Starts ${_start.format(context)} · $_minutes minutes'),
              trailing: const Icon(Icons.schedule),
              onTap: () async {
                final t = await showTimePicker(context: context, initialTime: _start);
                if (t != null) setState(() => _start = t);
              },
            ),
            Slider(value: _minutes.toDouble(), min: 30, max: 240, divisions: 14, label: '$_minutes min', onChanged: (v) => setState(() => _minutes = v.round())),
            if (_type == 'group') ...[
              TextField(controller: _capacity, keyboardType: TextInputType.number, decoration: _field('Capacity')),
              const SizedBox(height: 8),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: _mode == 'open',
                onChanged: (v) => setState(() => _mode = v ? 'open' : 'fixed'),
                title: const Text('Open for players to request'),
              ),
            ],
            DropdownButtonFormField<String>(
              initialValue: _area,
              decoration: _field('Training area or wicket'),
              items: [for (final a in areas) DropdownMenuItem(value: a.$1, child: Text(a.$2))],
              onChanged: (v) => setState(() => _area = v),
            ),
            const SizedBox(height: 12),
            Text('Coaches', style: Theme.of(context).textTheme.titleSmall),
            Wrap(spacing: 6, children: [
              for (final c in coaches.cast<Map<String, dynamic>>())
                FilterChip(
                  label: Text(c['full_name'] as String),
                  selected: _coaches.contains(c['id']),
                  onSelected: (v) => setState(() => v ? _coaches.add(c['id'] as String) : _coaches.remove(c['id'])),
                ),
            ]),
            const SizedBox(height: 12),
            Text(maxPlayers == null ? 'Players booked in (optional)' : 'Players (up to $maxPlayers)', style: Theme.of(context).textTheme.titleSmall),
            Wrap(spacing: 6, children: [
              for (final p in players.cast<Map<String, dynamic>>())
                FilterChip(
                  label: Text(p['full_name'] as String),
                  selected: _players.contains(p['id']),
                  onSelected: (v) => setState(() {
                    if (!v) {
                      _players.remove(p['id']);
                    } else if (maxPlayers == null || _players.length < maxPlayers) {
                      _players.add(p['id'] as String);
                    }
                  }),
                ),
            ]),
            const SizedBox(height: 20),
            FilledButton(onPressed: _busy ? null : _save, child: const Text('Create session')),
          ]);
        },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Give a player a package: from one of the academy's designs, or custom parts.
// ---------------------------------------------------------------------------

class AddPackageScreen extends StatefulWidget {
  const AddPackageScreen({super.key, required this.playerId, required this.playerName});
  final String playerId;
  final String playerName;
  @override
  State<AddPackageScreen> createState() => _AddPackageScreenState();
}

class _AddPackageScreenState extends State<AddPackageScreen> {
  String? _template; // null = custom
  DateTime _start = DateTime.now();
  DateTime _end = DateTime.now().add(const Duration(days: 29));
  final _name = TextEditingController(text: 'Custom package');
  final _price = TextEditingController();
  List<Map<String, dynamic>> _templates = const [];
  final Map<String, TextEditingController> _counts = {};
  bool _busy = false;

  void _pick(String? id) {
    setState(() => _template = id);
    final t = _templates.where((t) => t['id'] == id).firstOrNull;
    final p = t?['price_paise'] as num?;
    _price.text = p == null ? '' : (p % 100 == 0 ? '${p ~/ 100}' : (p / 100).toStringAsFixed(2));
  }

  Future<(List<dynamic>, List<dynamic>)> _load() async {
    final api = context.read<ApiClient>();
    final templates = (await api.get('/v1/package-templates') as List).where((t) => t['active'] == true).toList();
    _templates = templates.cast<Map<String, dynamic>>();
    if (_template == null && templates.isNotEmpty) _pick(templates.first['id'] as String);
    return (templates, await api.get('/v1/categories') as List);
  }

  Future<void> _save() async {
    final items = [
      for (final e in _counts.entries)
        if ((int.tryParse(e.value.text) ?? 0) > 0) {'categoryId': e.key, 'total': int.parse(e.value.text)},
    ];
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().post('/v1/players/${widget.playerId}/packages', _template != null
          ? {'templateId': _template, 'starts_on': _ymd.format(_start), 'price': ?double.tryParse(_price.text.trim())}
          : {'kind': 'fixed', 'name': _name.text.trim(), 'starts_on': _ymd.format(_start), 'expires_on': _ymd.format(_end), 'items': items, 'price': ?double.tryParse(_price.text.trim())});
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Package for ${widget.playerName}')),
      body: OnlineLoader<(List<dynamic>, List<dynamic>)>(
        load: _load,
        builder: (context, data, _) {
          final (templates, cats) = data;
          return ListView(padding: const EdgeInsets.all(16), children: [
            RadioGroup<String?>(
              groupValue: _template,
              onChanged: _pick,
              child: Column(children: [
                for (final t in templates.cast<Map<String, dynamic>>())
                  RadioListTile<String?>(
                    contentPadding: EdgeInsets.zero,
                    value: t['id'] as String,
                    title: Text(t['name'] as String),
                    subtitle: Text([
                      t['kind'] == 'fixed' ? (t['items'] as List).map((i) => '${i['total']} ${i['categoryName']}').join(' + ') : 'Flexible',
                      '${t['validity_days']} days',
                      if (t['price_paise'] != null) formatRupees(t['price_paise'] as num),
                    ].join(' · ')),
                  ),
                const RadioListTile<String?>(contentPadding: EdgeInsets.zero, value: null, title: Text('Custom')),
              ]),
            ),
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('Starts ${DateFormat('EEE d MMM yyyy').format(_start)}'),
              trailing: const Icon(Icons.calendar_today),
              onTap: () async {
                final d = await showDatePicker(context: context, initialDate: _start, firstDate: DateTime.now().subtract(const Duration(days: 60)), lastDate: DateTime.now().add(const Duration(days: 365)));
                if (d != null) setState(() => _start = d);
              },
            ),
            if (_template == null) ...[
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text('Ends ${DateFormat('EEE d MMM yyyy').format(_end)}'),
                trailing: const Icon(Icons.event),
                onTap: () async {
                  final d = await showDatePicker(context: context, initialDate: _end, firstDate: _start, lastDate: _start.add(const Duration(days: 730)));
                  if (d != null) setState(() => _end = d);
                },
              ),
              TextField(controller: _name, decoration: _field('Package name')),
              const SizedBox(height: 12),
              Text('Sessions of each kind', style: Theme.of(context).textTheme.titleSmall),
              for (final c in cats.cast<Map<String, dynamic>>().where((c) => c['active'] == true))
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Row(children: [
                    Expanded(child: Text(c['name'] as String)),
                    SizedBox(
                      width: 90,
                      child: TextField(
                        controller: _counts.putIfAbsent(c['id'] as String, () => TextEditingController()),
                        keyboardType: TextInputType.number,
                        textAlign: TextAlign.center,
                        decoration: const InputDecoration(hintText: '0', border: OutlineInputBorder(), isDense: true),
                      ),
                    ),
                  ]),
                ),
            ],
            const SizedBox(height: 16),
            TextField(
              controller: _price,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: _field('Price (optional)').copyWith(prefixText: '₹ ', helperText: 'A fee for this amount is added to the player\'s account'),
            ),
            const SizedBox(height: 20),
            FilledButton(onPressed: _busy ? null : _save, child: const Text('Give package')),
          ]);
        },
      ),
    );
  }
}
