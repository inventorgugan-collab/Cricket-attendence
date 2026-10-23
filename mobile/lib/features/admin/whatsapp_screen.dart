import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../ui/components.dart';
import '../common/requests_list.dart';
import '../common/widgets.dart';

/// WhatsApp through the official WhatsApp Business Platform. Until the academy
/// connects its own WhatsApp Business number, every message is kept here as a
/// preview so the admin can see exactly what would have been sent.
class WhatsAppScreen extends StatelessWidget {
  const WhatsAppScreen({super.key});

  @override
  Widget build(BuildContext context) => DefaultTabController(
        length: 3,
        child: Scaffold(
          appBar: AppBar(
            title: const Text('WhatsApp'),
            bottom: const TabBar(tabs: [Tab(text: 'Setup'), Tab(text: 'People'), Tab(text: 'Messages')]),
          ),
          body: const TabBarView(children: [_Setup(), _People(), _Messages()]),
        ),
      );
}

class _Setup extends StatelessWidget {
  const _Setup();

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return OnlineLoader<Map<String, dynamic>>(
      load: () async => await api.get('/v1/whatsapp/settings') as Map<String, dynamic>,
      builder: (context, s, reload) => _SetupForm(s: s, reload: reload),
    );
  }
}

class _SetupForm extends StatefulWidget {
  const _SetupForm({required this.s, required this.reload});
  final Map<String, dynamic> s;
  final Future<void> Function() reload;
  @override
  State<_SetupForm> createState() => _SetupFormState();
}

class _SetupFormState extends State<_SetupForm> {
  late final _phoneId = TextEditingController(text: widget.s['phoneNumberId'] as String? ?? '');
  final _token = TextEditingController();
  late final _template = TextEditingController(text: widget.s['templateName'] as String? ?? 'academy_update');
  late final _group = TextEditingController(text: widget.s['coachGroupId'] as String? ?? '');
  late int _hour = widget.s['digestHour'] as int? ?? 20;
  late bool _digest = widget.s['digestEnabled'] as bool? ?? true;
  bool _busy = false;
  String? _preview;

  Future<void> _save() async {
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().put('/v1/whatsapp/settings', {
        'phoneNumberId': _phoneId.text.trim().isEmpty ? null : _phoneId.text.trim(),
        if (_token.text.trim().isNotEmpty) 'accessToken': _token.text.trim(),
        'templateName': _template.text.trim(),
        'coachGroupId': _group.text.trim().isEmpty ? null : _group.text.trim(),
        'digestHour': _hour,
        'digestEnabled': _digest,
      });
      if (mounted) showMessage(context, 'Saved');
      await widget.reload();
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _digestNow(bool send) async {
    try {
      final r = await context.read<ApiClient>().post('/v1/whatsapp/digest', {'send': send}) as Map<String, dynamic>;
      if (!mounted) return;
      if (send) {
        showMessage(context, widget.s['connected'] == true ? 'Sent to the coaches.' : 'Saved as a preview. Coaches also got it in the app.');
      } else {
        setState(() => _preview = r['text'] as String?);
      }
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.s;
    final connected = s['connected'] == true;
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return ListView(padding: const EdgeInsets.only(bottom: 32), children: [
      Card(
        margin: const EdgeInsets.fromLTRB(12, 12, 12, 4),
        color: connected ? scheme.primaryContainer : scheme.tertiaryContainer,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(connected ? Icons.check_circle : Icons.visibility_outlined, color: connected ? scheme.onPrimaryContainer : scheme.onTertiaryContainer),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(connected ? 'Connected' : 'Preview mode', style: text.titleMedium),
                const SizedBox(height: 4),
                Text(connected
                    ? 'Messages go out from your WhatsApp Business number to people who have agreed to them.'
                    : 'Nothing is sent yet. Each message is kept under Messages so you can see what would go out. Connect your WhatsApp Business number below to start sending.'),
              ]),
            ),
          ]),
        ),
      ),
      const SectionHeader("Coaches' end-of-day summary"),
      GroupCard(children: [
        SwitchListTile(
          title: const Text('Send every evening'),
          subtitle: const Text('Who was on leave, which sessions another coach covered, what still needs a coach, and tomorrow\'s count'),
          value: _digest,
          onChanged: (v) => setState(() => _digest = v),
        ),
        ListTile(
          title: const Text('Time'),
          trailing: DropdownButton<int>(
            value: _hour,
            underline: const SizedBox(),
            items: [for (var h = 16; h <= 23; h++) DropdownMenuItem(value: h, child: Text('${h > 12 ? h - 12 : h}:00 pm'))],
            onChanged: (v) => setState(() => _hour = v ?? _hour),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
          child: Row(children: [
            Expanded(child: OutlinedButton(onPressed: () => _digestNow(false), child: const Text("See today's"))),
            const SizedBox(width: 8),
            Expanded(child: FilledButton.tonal(onPressed: () => _digestNow(true), child: const Text('Send now'))),
          ]),
        ),
      ]),
      if (_preview != null)
        Padding(padding: const EdgeInsets.fromLTRB(12, 8, 12, 0), child: WhatsAppBubble(text: _preview!)),
      const SectionHeader('WhatsApp Business connection'),
      Card(
        margin: const EdgeInsets.symmetric(horizontal: 12),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('From your Meta Business account (WhatsApp Manager → API setup).', style: text.bodySmall),
            const SizedBox(height: 12),
            TextField(controller: _phoneId, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Phone number ID')),
            const SizedBox(height: 12),
            TextField(
              controller: _token,
              obscureText: true,
              decoration: InputDecoration(
                labelText: 'Access token',
                helperText: s['hasAccessToken'] == true ? 'A token is saved. It is never shown again; paste a new one to replace it.' : 'A permanent system-user token',
                helperMaxLines: 2,
              ),
            ),
            const SizedBox(height: 12),
            TextField(controller: _template, decoration: const InputDecoration(labelText: 'Approved message template', helperText: 'Two text fields: the academy name and the message')),
            const SizedBox(height: 12),
            TextField(
              controller: _group,
              decoration: const InputDecoration(
                labelText: 'Coaches group ID (optional)',
                helperText: 'WhatsApp only lets verified business accounts post to groups. Until then the summary goes to each coach.',
                helperMaxLines: 3,
              ),
            ),
            const SizedBox(height: 16),
            FilledButton(onPressed: _busy ? null : _save, child: Text(_busy ? 'Saving…' : 'Save')),
          ]),
        ),
      ),
    ]);
  }
}

/// A message drawn like a WhatsApp chat bubble.
class WhatsAppBubble extends StatelessWidget {
  const WhatsAppBubble({super.key, required this.text, this.footer});
  final String text;
  final String? footer;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: dark ? const Color(0xFF0B2E22) : const Color(0xFFEAF6E4),
        borderRadius: const BorderRadius.only(topLeft: Radius.circular(4), topRight: Radius.circular(14), bottomLeft: Radius.circular(14), bottomRight: Radius.circular(14)),
        border: Border.all(color: dark ? const Color(0xFF1C4A38) : const Color(0xFFD3E9C9)),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(text),
        if (footer != null) ...[const SizedBox(height: 6), Text(footer!, style: Theme.of(context).textTheme.bodySmall)],
      ]),
    );
  }
}

class _People extends StatelessWidget {
  const _People();

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return OnlineLoader<List<dynamic>>(
      load: () async => await api.get('/v1/whatsapp/people') as List<dynamic>,
      builder: (context, rows, reload) {
        final people = rows.cast<Map<String, dynamic>>();
        final on = people.where((p) => p['whatsapp_opt_in'] == true).length;
        final children = <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
            child: Text('$on of ${people.length} people get WhatsApp messages. WhatsApp\'s rules say each person must agree first, so only switch someone on once they have said yes.',
                style: Theme.of(context).textTheme.bodySmall),
          ),
        ];
        final groups = <String, List<Widget>>{};
        for (final p in people) {
          final role = p['role'] as String;
          groups.putIfAbsent(role, () => []).add(SwitchListTile(
                title: Text(p['display_name'] as String),
                subtitle: Text(p['phone'] == null ? 'No mobile number on record' : '+${p['phone']}'),
                value: p['whatsapp_opt_in'] == true,
                onChanged: (v) => _set(context, p, v, reload),
                secondary: IconButton(tooltip: 'Change number', icon: const Icon(Icons.edit_outlined, size: 20), onPressed: () => _phone(context, p, reload)),
              ));
        }
        for (final e in groups.entries) {
          children.add(SectionHeader(switch (e.key) { 'admin' => 'Admins', 'coach' => 'Coaches', 'guardian' => 'Parents', _ => 'Players' }));
          children.add(GroupCard(children: e.value));
        }
        children.add(const SizedBox(height: 24));
        return ListView(children: children);
      },
    );
  }

  Future<void> _set(BuildContext context, Map<String, dynamic> p, bool v, Future<void> Function() reload) async {
    if (v && p['phone'] == null) return _phone(context, p, reload);
    try {
      await context.read<ApiClient>().put('/v1/users/${p['id']}/whatsapp', {'optIn': v});
      await reload();
    } catch (e) {
      if (context.mounted) showMessage(context, e);
    }
  }

  Future<void> _phone(BuildContext context, Map<String, dynamic> p, Future<void> Function() reload) async {
    final number = await askText(context, title: 'WhatsApp number for ${p['display_name']}', label: 'Mobile number', initial: (p['whatsapp_phone'] as String?) ?? '', action: 'Save and switch on');
    if (number == null || !context.mounted) return;
    try {
      await context.read<ApiClient>().put('/v1/users/${p['id']}/whatsapp', {'optIn': true, 'phone': number.isEmpty ? null : number});
      await reload();
    } catch (e) {
      if (context.mounted) showMessage(context, e);
    }
  }
}

class _Messages extends StatelessWidget {
  const _Messages();

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return OnlineLoader<List<dynamic>>(
      load: () async => await api.get('/v1/whatsapp/messages') as List<dynamic>,
      builder: (context, rows, reload) {
        if (rows.isEmpty) return const EmptyState('Messages appear here as things happen: leave, cover, bookings and the evening summary.', icon: Icons.chat_outlined);
        return ListView(padding: const EdgeInsets.fromLTRB(12, 8, 12, 24), children: [
          for (final m in rows.cast<Map<String, dynamic>>())
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(
                    child: Text(m['to_group'] != null ? 'Coaches group' : '${m['to_name'] ?? 'Someone'}${m['to_phone'] == null ? '' : ' · +${m['to_phone']}'}',
                        style: Theme.of(context).textTheme.labelLarge),
                  ),
                  _statusPill(context, m['status'] as String),
                ]),
                const SizedBox(height: 4),
                WhatsAppBubble(
                  text: m['body'] as String,
                  footer: [formatWhen(m['created_at'] as String), if (m['status_reason'] != null) m['status_reason'] as String].join(' · '),
                ),
              ]),
            ),
        ]);
      },
    );
  }

  Widget _statusPill(BuildContext context, String status) => switch (status) {
        'sent' => Pill.tone(context, 'Sent', 'good', icon: Icons.done_all),
        'preview' => Pill.tone(context, 'Preview', 'warn'),
        'queued' => Pill.tone(context, 'Sending', 'neutral'),
        'failed' => Pill.tone(context, 'Failed', 'bad'),
        _ => Pill.tone(context, 'Not sent', 'neutral'),
      };
}
