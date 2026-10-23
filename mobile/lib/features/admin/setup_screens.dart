import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../coach/leave_screen.dart';
import 'admin_forms.dart' show createLogin;
import 'admin_home.dart' show ConflictsScreen;
import 'money_screens.dart';
import 'whatsapp_screen.dart';
import '../../ui/components.dart';
import '../common/widgets.dart';

/// The academy's own rules: kinds of session and who coaches them, package
/// designs, and coach leave.
class SetupScreen extends StatelessWidget {
  const SetupScreen({super.key});

  @override
  Widget build(BuildContext context) {
    void open(Widget w) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => w));
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Academy setup')),
      body: ListView(padding: const EdgeInsets.only(bottom: 24), children: [
        const SectionHeader('Coaching', padding: EdgeInsets.fromLTRB(16, 4, 16, 6)),
        GroupCard(children: [
          MenuTile(icon: Icons.sports_outlined, title: 'Coaches', subtitle: 'Add coaches and give them a login', onTap: () => open(const CoachesScreen())),
          MenuTile(
            icon: Icons.format_list_numbered,
            title: 'Kinds of session and coach order',
            subtitle: 'Who takes one-on-ones, S&C and so on, and who is asked first',
            onTap: () => open(const CategoriesScreen()),
          ),
          MenuTile(icon: Icons.event_busy, title: 'Coach leave', subtitle: 'Planned and emergency leave on record', onTap: () => open(const LeaveScreen())),
        ]),
        const SectionHeader('Packages and money'),
        GroupCard(children: [
          MenuTile(icon: Icons.inventory_2_outlined, title: 'Package designs', subtitle: 'e.g. 12 sessions = 9 one-on-one + 3 S&C, and the price', onTap: () => open(const TemplatesScreen())),
          MenuTile(icon: Icons.currency_rupee, title: 'Coach pay rates', subtitle: 'Per session, with different rates for some kinds', onTap: () => open(const CoachRatesScreen())),
        ]),
        const SectionHeader('Messages'),
        GroupCard(children: [
          MenuTile(
            icon: Icons.chat_outlined,
            color: const Color(0xFF1FA855),
            title: 'WhatsApp',
            subtitle: "Connection, who gets messages, and the coaches' evening summary",
            onTap: () => open(const WhatsAppScreen()),
          ),
        ]),
        const SectionHeader('Data'),
        GroupCard(children: [
          MenuTile(icon: Icons.call_split, color: scheme.secondary, title: 'Offline conflicts', subtitle: 'Changes made offline that clashed with someone else\'s', onTap: () => open(const ConflictsScreen())),
        ]),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------

class CategoriesScreen extends StatelessWidget {
  const CategoriesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return Scaffold(
      appBar: AppBar(title: const Text('Kinds of session')),
      body: OnlineLoader<List<dynamic>>(
        load: () async => await api.get('/v1/categories') as List<dynamic>,
        builder: (context, cats, reload) => ListView(children: [
          for (final c in cats.cast<Map<String, dynamic>>())
            ListTile(
              title: Text(c['name'] as String),
              subtitle: Text([
                '${humanise(c['session_type'] as String)} · ${c['default_minutes']} min',
                if (c['requestable'] == true) 'Families can ask for a time',
                if (c['active'] != true) 'Not in use',
                (c['coaches'] as List).isEmpty ? 'No coaches set' : 'Coaches: ${(c['coaches'] as List).map((x) => x['full_name']).join(' → ')}',
              ].join('\n')),
              isThreeLine: true,
              trailing: const Icon(Icons.chevron_right),
              onTap: () async {
                await Navigator.of(context).push(MaterialPageRoute(builder: (_) => CategoryScreen(category: c)));
                await reload();
              },
            ),
        ]),
      ),
    );
  }
}

/// One kind of session: whether families can request it, how long it runs,
/// and the coaches who take it in the order they're asked.
class CategoryScreen extends StatefulWidget {
  const CategoryScreen({super.key, required this.category});
  final Map<String, dynamic> category;
  @override
  State<CategoryScreen> createState() => _CategoryScreenState();
}

class _CategoryScreenState extends State<CategoryScreen> {
  late bool _requestable = widget.category['requestable'] == true;
  late int _minutes = widget.category['default_minutes'] as int;
  late final List<Map<String, dynamic>> _order = (widget.category['coaches'] as List).cast<Map<String, dynamic>>().toList();
  List<Map<String, dynamic>> _allCoaches = [];
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    context.read<ApiClient>().get('/v1/coaches').then((r) {
      if (mounted) setState(() => _allCoaches = (r as List).cast<Map<String, dynamic>>());
    }).catchError((_) {});
  }

  Future<void> _save() async {
    final api = context.read<ApiClient>();
    setState(() => _busy = true);
    try {
      final id = widget.category['id'];
      await api.patch('/v1/categories/$id', {'requestable': _requestable, 'defaultMinutes': _minutes});
      await api.put('/v1/categories/$id/coaches', {'coachIds': [for (final c in _order) c['id']]});
      if (!mounted) return;
      showMessage(context, 'Saved');
      Navigator.of(context).pop();
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final others = _allCoaches.where((c) => !_order.any((o) => o['id'] == c['id'])).toList();
    return Scaffold(
      appBar: AppBar(title: Text(widget.category['name'] as String), actions: [
        TextButton(onPressed: _busy ? null : _save, child: const Text('Save')),
      ]),
      body: ListView(padding: const EdgeInsets.symmetric(vertical: 8), children: [
        SwitchListTile(
          value: _requestable,
          onChanged: (v) => setState(() => _requestable = v),
          title: const Text('Families can ask for a time'),
          subtitle: const Text('Players and parents pick a time when a coach below is free'),
        ),
        ListTile(
          title: Text('Session length: $_minutes minutes'),
          subtitle: Slider(value: _minutes.toDouble(), min: 30, max: 180, divisions: 10, label: '$_minutes', onChanged: (v) => setState(() => _minutes = v.round())),
        ),
        const Divider(),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
          child: Text('Coach order', style: Theme.of(context).textTheme.titleMedium),
        ),
        const Padding(
          padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: Text('A request goes to the first coach who is free at that time. If they are busy, on leave or pass it on, the next coach gets it. Drag to reorder.'),
        ),
        ReorderableListView(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          buildDefaultDragHandles: false,
          onReorderItem: (from, to) => setState(() => _order.insert(to, _order.removeAt(from))),
          children: [
            for (final (i, c) in _order.indexed)
              ListTile(
                key: ValueKey(c['id']),
                leading: CircleAvatar(child: Text('${i + 1}')),
                title: Text(c['full_name'] as String),
                trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                  IconButton(tooltip: 'Remove', icon: const Icon(Icons.remove_circle_outline), onPressed: () => setState(() => _order.removeAt(i))),
                  ReorderableDragStartListener(index: i, child: const Icon(Icons.drag_handle)),
                ]),
              ),
          ],
        ),
        if (others.isNotEmpty)
          Padding(
            padding: const EdgeInsets.all(16),
            child: Wrap(spacing: 8, runSpacing: 8, children: [
              for (final c in others)
                ActionChip(avatar: const Icon(Icons.add, size: 18), label: Text(c['full_name'] as String), onPressed: () => setState(() => _order.add(c))),
            ]),
          ),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------

class TemplatesScreen extends StatefulWidget {
  const TemplatesScreen({super.key});
  @override
  State<TemplatesScreen> createState() => _TemplatesScreenState();
}

class _TemplatesScreenState extends State<TemplatesScreen> {
  int _version = 0;

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return Scaffold(
      appBar: AppBar(title: const Text('Package designs')),
      body: OnlineLoader<List<dynamic>>(
        key: ValueKey(_version),
        load: () async => await api.get('/v1/package-templates') as List<dynamic>,
        builder: (context, items, reload) {
          if (items.isEmpty) return const EmptyState('No package designs yet. Add one, e.g. "12-session pack: 9 one-on-one + 3 S&C".');
          return ListView(children: [
            for (final t in items.cast<Map<String, dynamic>>())
              ListTile(
                title: Text(t['name'] as String, style: t['active'] == true ? null : const TextStyle(decoration: TextDecoration.lineThrough)),
                subtitle: Text([
                  t['kind'] == 'fixed' ? (t['items'] as List).map((i) => '${i['total']} ${i['categoryName']}').join(' + ') : 'Flexible',
                  'valid ${t['validity_days']} days',
                  if (t['price_paise'] != null) formatRupees(t['price_paise'] as num),
                ].join(' · ')),
                trailing: Switch(
                  value: t['active'] == true,
                  onChanged: (v) async {
                    await api.patch('/v1/package-templates/${t['id']}', {'active': v});
                    await reload();
                  },
                ),
              ),
          ]);
        },
      ),
      floatingActionButton: FloatingActionButton.extended(
        icon: const Icon(Icons.add),
        label: const Text('New design'),
        onPressed: () async {
          final ok = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => const NewTemplateScreen()));
          if (ok == true) setState(() => _version++);
        },
      ),
    );
  }
}

class NewTemplateScreen extends StatefulWidget {
  const NewTemplateScreen({super.key});
  @override
  State<NewTemplateScreen> createState() => _NewTemplateScreenState();
}

class _NewTemplateScreenState extends State<NewTemplateScreen> {
  final _name = TextEditingController();
  final _days = TextEditingController(text: '90');
  final _price = TextEditingController();
  final Map<String, TextEditingController> _counts = {};

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return Scaffold(
      appBar: AppBar(title: const Text('New package design')),
      body: OnlineLoader<List<dynamic>>(
        load: () async => await api.get('/v1/categories') as List<dynamic>,
        builder: (context, cats, _) {
          final total = _counts.values.fold<int>(0, (a, c) => a + (int.tryParse(c.text) ?? 0));
          return ListView(padding: const EdgeInsets.all(16), children: [
            TextField(controller: _name, decoration: const InputDecoration(labelText: 'Name, e.g. 12-session pack', border: OutlineInputBorder())),
            const SizedBox(height: 12),
            TextField(controller: _days, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Valid for (days)', border: OutlineInputBorder())),
            const SizedBox(height: 12),
            TextField(
              controller: _price,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'Price (optional)', prefixText: '₹ ', helperText: 'A fee for this amount is added when the package is given'),
            ),
            const SizedBox(height: 16),
            Text('Sessions of each kind', style: Theme.of(context).textTheme.titleMedium),
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
                      onChanged: (_) => setState(() {}),
                      decoration: const InputDecoration(hintText: '0', border: OutlineInputBorder(), isDense: true),
                    ),
                  ),
                ]),
              ),
            const SizedBox(height: 16),
            Text('$total sessions in total', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: () async {
                final items = [
                  for (final e in _counts.entries)
                    if ((int.tryParse(e.value.text) ?? 0) > 0) {'categoryId': e.key, 'total': int.parse(e.value.text)},
                ];
                try {
                  await api.post('/v1/package-templates', {
                    'name': _name.text.trim(),
                    'kind': 'fixed',
                    'validity_days': int.tryParse(_days.text) ?? 30,
                    'items': items,
                    if (double.tryParse(_price.text.trim()) != null) 'price': double.parse(_price.text.trim()),
                  });
                  if (context.mounted) Navigator.of(context).pop(true);
                } catch (e) {
                  if (context.mounted) showMessage(context, e);
                }
              },
              child: const Text('Save design'),
            ),
          ]);
        },
      ),
    );
  }
}

// ---------------------------------------------------------------------------

/// Pick another coach for a session, best choice first: the category's coach
/// order, with who is free, on leave or already teaching at that time.
class ReassignCoachScreen extends StatelessWidget {
  const ReassignCoachScreen({super.key, required this.session, this.replacingCoachId});
  final Map<String, dynamic> session;
  final String? replacingCoachId;

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    final id = session['id'] as String;
    return Scaffold(
      appBar: AppBar(title: const Text('Change coach')),
      body: OnlineLoader<List<dynamic>>(
        load: () async => await api.get('/v1/sessions/$id/available-coaches') as List<dynamic>,
        builder: (context, coaches, _) {
          final list = coaches.cast<Map<String, dynamic>>();
          final current = list.where((c) => c['current'] == true).map((c) => c['id'] as String).toList();
          return ListView(children: [
            ListTile(
              title: Text(sessionLabel(session), style: Theme.of(context).textTheme.titleMedium),
              subtitle: Text('${formatWhen(session['starts_at'] as String)}${session['coach_name'] != null ? '\n${session['coach_name']} is on ${session['leave_kind'] == 'emergency' ? 'emergency ' : ''}leave' : ''}'),
            ),
            const Divider(),
            for (final c in list)
              ListTile(
                leading: CircleAvatar(child: Text(c['priority'] == null ? '–' : '${c['priority']}')),
                title: Text(c['full_name'] as String),
                subtitle: Text(_state(c)),
                enabled: _canTake(c),
                trailing: _canTake(c) ? const Icon(Icons.swap_horiz) : null,
                onTap: () async {
                  final next = [...current.where((x) => x != (replacingCoachId ?? (current.length == 1 ? current.first : null))), c['id'] as String];
                  try {
                    await api.put('/v1/sessions/$id/coaches', {'coachIds': next, 'reason': 'Coach changed by the academy'});
                    if (!context.mounted) return;
                    showMessage(context, '${c['full_name']} now has this session. The coaches and players have been told.');
                    Navigator.of(context).pop(true);
                  } catch (e) {
                    if (context.mounted) showMessage(context, e);
                  }
                },
              ),
          ]);
        },
      ),
    );
  }

  static bool _canTake(Map<String, dynamic> c) => c['current'] != true && c['on_leave'] != true && c['busy'] != true;

  static String _state(Map<String, dynamic> c) {
    if (c['current'] == true) return c['on_leave'] == true ? 'On this session, but on leave' : 'On this session';
    if (c['on_leave'] == true) return 'On leave';
    if (c['busy'] == true) return 'Teaching another session';
    if (c['outside_hours'] == true) return 'Free, but outside their usual hours';
    return c['priority'] == null ? 'Free (not in this session type\'s coach list)' : 'Free';
  }
}

// ---------------------------------------------------------------------------

/// The academy's coaches: add one, give them a login, see who can sign in.
class CoachesScreen extends StatelessWidget {
  const CoachesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return Scaffold(
      appBar: AppBar(title: const Text('Coaches')),
      body: OnlineLoader<List<dynamic>>(
        load: () async => await api.get('/v1/coaches') as List<dynamic>,
        builder: (context, coaches, reload) {
          if (coaches.isEmpty) return const EmptyState('No coaches yet. Add your first coach.', icon: Icons.sports_outlined);
          return ListView(padding: const EdgeInsets.fromLTRB(0, 4, 0, 96), children: [
            GroupCard(children: [
              for (final c in coaches.cast<Map<String, dynamic>>())
                ListTile(
                  leading: Avatar(c['full_name'] as String),
                  title: Text(c['full_name'] as String),
                  subtitle: Text([if (c['phone'] != null) c['phone'] as String, c['user_id'] == null ? 'No login yet' : 'Can sign in'].join(' · ')),
                  trailing: c['user_id'] == null
                      ? TextButton(
                          onPressed: () => createLogin(context,
                              role: 'coach', profileId: c['id'] as String, name: c['full_name'] as String, reload: reload, suggestedLogin: c['phone'] as String?),
                          child: const Text('Create login'),
                        )
                      : null,
                ),
            ]),
          ]);
        },
      ),
      floatingActionButton: Builder(
        builder: (context) => FloatingActionButton.extended(
          icon: const Icon(Icons.person_add),
          label: const Text('Add coach'),
          onPressed: () => _add(context),
        ),
      ),
    );
  }

  Future<void> _add(BuildContext context) async {
    final name = TextEditingController();
    final phone = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Add coach'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: name, autofocus: true, decoration: const InputDecoration(labelText: 'Full name')),
          const SizedBox(height: 8),
          TextField(controller: phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Mobile number')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Add')),
        ],
      ),
    );
    if (ok != true || name.text.trim().isEmpty || !context.mounted) return;
    try {
      final c = await context.read<ApiClient>().post('/v1/coaches', {'full_name': name.text.trim(), if (phone.text.trim().isNotEmpty) 'phone': phone.text.trim()}) as Map<String, dynamic>;
      if (!context.mounted) return;
      // Straight on to the login, which is what the admin almost always wants next.
      await createLogin(context, role: 'coach', profileId: c['id'] as String, name: c['full_name'] as String, reload: () async {
        await Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const CoachesScreen()));
      }, suggestedLogin: phone.text.trim());
    } catch (e) {
      if (context.mounted) showMessage(context, e);
    }
  }
}
