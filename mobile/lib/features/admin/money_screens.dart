import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../ui/components.dart';
import '../../ui/theme.dart';
import '../common/requests_list.dart';
import '../common/widgets.dart';

// Fees, payments, coach pay and expenses. Admin only: the server refuses every
// one of these calls from coaches, players and parents, and none of it is
// synced to their phones.

const methods = ['cash', 'upi', 'bank', 'card', 'cheque', 'other'];
const expenseCategories = ['rent', 'ground', 'equipment', 'travel', 'staff', 'utilities', 'other'];

String methodLabel(String m) => switch (m) { 'upi' => 'UPI', 'bank' => 'Bank transfer', _ => humanise(m) };
String monthLabel(String m) => DateFormat('MMMM yyyy').format(DateTime.parse('$m-01'));
String monthOf(DateTime d) => DateFormat('yyyy-MM').format(d);
String today() => DateFormat('yyyy-MM-dd').format(DateTime.now());
String shortDay(String iso) => DateFormat('d MMM').format(DateTime.parse(iso.length == 10 ? '${iso}T12:00:00' : iso).toLocal());

Future<T?> _open<T>(BuildContext context, Widget w) => Navigator.of(context).push<T>(MaterialPageRoute(builder: (_) => w));

/// The admin's Money tab: the month at a glance.
class MoneyTab extends StatefulWidget {
  const MoneyTab({super.key});
  @override
  State<MoneyTab> createState() => _MoneyTabState();
}

class _MoneyTabState extends State<MoneyTab> {
  String _month = monthOf(DateTime.now());

  void _shift(int by) {
    final d = DateTime.parse('$_month-01');
    setState(() => _month = monthOf(DateTime(d.year, d.month + by)));
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    final isCurrent = _month == monthOf(DateTime.now());
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(8, 0, 8, 4),
        child: Row(children: [
          IconButton(tooltip: 'Previous month', onPressed: () => _shift(-1), icon: const Icon(Icons.chevron_left)),
          Expanded(child: Text(monthLabel(_month), textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium)),
          IconButton(tooltip: 'Next month', onPressed: isCurrent ? null : () => _shift(1), icon: const Icon(Icons.chevron_right)),
        ]),
      ),
      Expanded(
        child: OnlineLoader<Map<String, dynamic>>(
          key: ValueKey(_month),
          load: () async => await api.get('/v1/finance/month?month=$_month') as Map<String, dynamic>,
          builder: (context, m, reload) => _MonthView(month: _month, m: m, reload: reload),
        ),
      ),
    ]);
  }
}

class _MonthView extends StatelessWidget {
  const _MonthView({required this.month, required this.m, required this.reload});
  final String month;
  final Map<String, dynamic> m;
  final Future<void> Function() reload;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    final money = m['money'] as Map<String, dynamic>;
    final sessions = m['sessions'] as Map<String, dynamic>;
    final free = (sessions['free'] as Map?)?.cast<String, dynamic>() ?? const {'sessions': 0, 'attendances': 0, 'players': 0};
    final coaches = (m['coaches'] as List).cast<Map<String, dynamic>>();
    final profit = money['profit_paise'] as num;
    Future<void> then(Future<Object?> f) async {
      if (await f == true) await reload();
    }

    return ListView(padding: const EdgeInsets.only(bottom: 32), children: [
      // Profit, and how it was reached.
      Container(
        margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(20),
          gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [AppTheme.pitch, AppTheme.pitchDark]),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(profit >= 0 ? 'PROFIT' : 'LOSS', style: text.labelSmall?.copyWith(color: Colors.white70, letterSpacing: 1.1, fontWeight: FontWeight.w600)),
          Text(formatRupees(profit.abs()), style: text.headlineLarge?.copyWith(color: Colors.white)),
          const SizedBox(height: 14),
          _flow(context, 'Money in', money['received_paise'] as num, Icons.south_west),
          _flow(context, 'Paid to coaches', money['coach_payouts_paise'] as num, Icons.north_east),
          _flow(context, 'Other expenses', money['expenses_paise'] as num, Icons.north_east),
          Divider(color: Colors.white.withValues(alpha: 0.2), height: 18),
          _flow(context, 'Settled (paid out in total)', money['settled_paise'] as num, null),
        ]),
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Row(children: [
          Expanded(child: _Action(icon: Icons.payments_outlined, label: 'Record\npayment', onTap: () => then(_open(context, const RecordPaymentScreen())))),
          const SizedBox(width: 8),
          Expanded(child: _Action(icon: Icons.badge_outlined, label: 'Pay a\ncoach', onTap: () => then(_open(context, PayCoachScreen(month: month))))),
          const SizedBox(width: 8),
          Expanded(child: _Action(icon: Icons.receipt_long_outlined, label: 'Add\nexpense', onTap: () => then(_open(context, const AddExpenseScreen())))),
        ]),
      ),
      if ((money['outstanding_paise'] as num) > 0)
        Card(
          margin: const EdgeInsets.fromLTRB(12, 10, 12, 0),
          color: scheme.tertiaryContainer,
          child: ListTile(
            leading: Icon(Icons.hourglass_bottom, color: scheme.onTertiaryContainer),
            title: Text('${formatRupees(money['outstanding_paise'] as num)} still to collect', style: TextStyle(color: scheme.onTertiaryContainer)),
            subtitle: Text('${money['outstanding_fees']} unpaid fee${money['outstanding_fees'] == 1 ? '' : 's'} across all months', style: TextStyle(color: scheme.onTertiaryContainer)),
            trailing: Icon(Icons.chevron_right, color: scheme.onTertiaryContainer),
            onTap: () => then(_open(context, const OutstandingFeesScreen())),
          ),
        ),
      const SectionHeader('Sessions'),
      StatGrid(children: [
        StatTile(label: 'Sessions held', value: '${sessions['held']}', icon: Icons.event_available),
        StatTile(label: 'Player attendances', value: '${sessions['player_attendances']}', icon: Icons.groups_outlined),
        StatTile(label: 'One-on-one and pairs', value: '${sessions['individual_sessions']}', icon: Icons.person_outline, tone: 'accent'),
        StatTile(label: 'Group', value: '${sessions['group_sessions']}', icon: Icons.diversity_3, tone: 'accent'),
        StatTile(label: 'Hours coached', value: _hours(sessions['hours'] as num), icon: Icons.schedule),
        StatTile(label: 'Free sessions', value: '${free['sessions']}', icon: Icons.volunteer_activism_outlined, tone: 'accent'),
      ]),
      if ((free['players'] as num) > 0 || (free['attendances'] as num) > 0)
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: Text(
            '${free['attendances']} attendance${free['attendances'] == 1 ? '' : 's'} by players coached for free '
            '(${free['players']} player${free['players'] == 1 ? '' : 's'}). A free session is one where everyone who came was free.',
            style: text.bodySmall,
          ),
        ),
      if ((sessions['byCategory'] as List).isNotEmpty)
        GroupCard(margin: const EdgeInsets.fromLTRB(12, 8, 12, 0), children: [
          for (final c in (sessions['byCategory'] as List).cast<Map<String, dynamic>>())
            ListTile(dense: true, title: Text(c['name'] as String), trailing: Text('${c['sessions']}', style: text.titleSmall)),
          if ((sessions['cancelled'] as num) > 0) ListTile(dense: true, title: const Text('Cancelled'), trailing: Text('${sessions['cancelled']}', style: text.titleSmall)),
        ]),
      SectionHeader('Coaches', trailing: TextButton(onPressed: () => then(_open(context, const CoachRatesScreen())), child: const Text('Pay rates'))),
      GroupCard(children: [
        if (coaches.isEmpty) const ListTile(title: Text('No coaches yet')),
        for (final c in coaches)
          ListTile(
            leading: Avatar(c['full_name'] as String),
            title: Text(c['full_name'] as String),
            subtitle: Text(c['missing_rate'] == true
                ? '${c['sessions']} sessions · ${_hours(c['hours'] as num)} h · set a pay rate to work out pay'
                : '${c['sessions']} sessions · ${_hours(c['hours'] as num)} h · earned ${formatRupees(c['earned_paise'] as num)} · paid ${formatRupees(c['paid_paise'] as num)}'),
            trailing: (c['owed_paise'] as num) > 0
                ? Pill.tone(context, '${formatRupees(c['owed_paise'] as num)} due', 'warn')
                : (c['sessions'] as num) > 0 && c['missing_rate'] != true
                    ? Pill.tone(context, 'Settled', 'good')
                    : null,
            onTap: () => then(_open(context, PayCoachScreen(month: month, coachId: c['id'] as String, suggested: c['owed_paise'] as num))),
          ),
      ]),
      if ((money['byMethod'] as List).isNotEmpty) ...[
        const SectionHeader('Money in, by method'),
        GroupCard(children: [
          for (final r in (money['byMethod'] as List).cast<Map<String, dynamic>>())
            ListTile(dense: true, title: Text(methodLabel(r['method'] as String)), trailing: Text(formatRupees(r['amount_paise'] as num), style: text.titleSmall)),
        ]),
      ],
      if ((money['expensesByCategory'] as List).isNotEmpty) ...[
        const SectionHeader('Expenses'),
        GroupCard(children: [
          for (final r in (money['expensesByCategory'] as List).cast<Map<String, dynamic>>())
            ListTile(dense: true, title: Text(humanise(r['category'] as String)), trailing: Text(formatRupees(r['amount_paise'] as num), style: text.titleSmall)),
        ]),
      ],
      const SectionHeader('Records'),
      GroupCard(children: [
        MenuTile(icon: Icons.south_west, title: 'Payments received', subtitle: monthLabel(month), onTap: () => then(_open(context, LedgerScreen(month: month, kind: 'payments')))),
        MenuTile(icon: Icons.badge_outlined, title: 'Coach payouts', subtitle: monthLabel(month), onTap: () => then(_open(context, LedgerScreen(month: month, kind: 'coach-payouts')))),
        MenuTile(icon: Icons.receipt_long_outlined, title: 'Expenses', subtitle: monthLabel(month), onTap: () => then(_open(context, LedgerScreen(month: month, kind: 'expenses')))),
      ]),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
        child: Text('Only the academy admin can see this page. Mistakes are voided with a reason rather than deleted, so the totals can always be checked.',
            style: text.bodySmall),
      ),
    ]);
  }

  Widget _flow(BuildContext context, String label, num paise, IconData? icon) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(children: [
          if (icon != null) Icon(icon, size: 14, color: Colors.white70) else const SizedBox(width: 14),
          const SizedBox(width: 8),
          Expanded(child: Text(label, style: const TextStyle(color: Colors.white70))),
          Text(formatRupees(paise), style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
        ]),
      );
}

class _Action extends StatelessWidget {
  const _Action({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = Theme.of(context).colorScheme;
    return Card(
      margin: EdgeInsets.zero,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 8),
          child: Column(children: [
            Icon(icon, color: s.primary),
            const SizedBox(height: 6),
            Text(label, textAlign: TextAlign.center, style: Theme.of(context).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w600)),
          ]),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Forms

InputDecoration _field(String label, {String? prefix, String? helper}) => InputDecoration(labelText: label, prefixText: prefix, helperText: helper);

double? _rupeesIn(TextEditingController c) => double.tryParse(c.text.replaceAll(',', '').trim());

class _MethodPicker extends StatelessWidget {
  const _MethodPicker({required this.value, required this.onChanged});
  final String value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) => Wrap(spacing: 6, runSpacing: 6, children: [
        for (final m in methods) ChoiceChip(label: Text(methodLabel(m)), selected: value == m, onSelected: (_) => onChanged(m)),
      ]);
}

class _DateField extends StatelessWidget {
  const _DateField({required this.label, required this.value, required this.onChanged});
  final String label;
  final String value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) => InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () async {
          final d = await showDatePicker(context: context, initialDate: DateTime.parse(value), firstDate: DateTime(2020), lastDate: DateTime.now().add(const Duration(days: 365)));
          if (d != null) onChanged(DateFormat('yyyy-MM-dd').format(d));
        },
        child: InputDecorator(decoration: _field(label).copyWith(suffixIcon: const Icon(Icons.calendar_today_outlined, size: 18)), child: Text(formatDay('${value}T12:00:00'))),
      );
}

/// Scaffold for a money form: fields, an error line and a save button.
class _FormPage extends StatelessWidget {
  const _FormPage({required this.title, required this.children, required this.busy, required this.onSave, required this.saveLabel, this.error});
  final String title;
  final List<Widget> children;
  final bool busy;
  final VoidCallback onSave;
  final String saveLabel;
  final String? error;

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(title)),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          for (final c in children) Padding(padding: const EdgeInsets.only(bottom: 14), child: c),
          if (error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
          FilledButton(onPressed: busy ? null : onSave, child: Text(busy ? 'Saving…' : saveLabel)),
        ]),
      );
}

/// Money received from a player or their family, optionally against a fee.
class RecordPaymentScreen extends StatefulWidget {
  const RecordPaymentScreen({super.key, this.playerId, this.playerName, this.fee});
  final String? playerId;
  final String? playerName;
  final Map<String, dynamic>? fee;
  @override
  State<RecordPaymentScreen> createState() => _RecordPaymentScreenState();
}

class _RecordPaymentScreenState extends State<RecordPaymentScreen> {
  late String? _playerId = widget.playerId ?? widget.fee?['player_id'] as String?;
  late String? _feeId = widget.fee?['id'] as String?;
  late final _amount = TextEditingController(text: widget.fee == null ? '' : _plain(widget.fee!['balance_paise'] as num));
  final _reference = TextEditingController();
  String _method = 'upi';
  String _paidOn = today();
  bool _busy = false;
  String? _error;
  List<Map<String, dynamic>>? _players;
  List<Map<String, dynamic>> _fees = const [];

  @override
  void initState() {
    super.initState();
    final api = context.read<ApiClient>();
    if (_playerId == null) {
      api.get('/v1/players?status=active').then((r) => mounted ? setState(() => _players = (r as List).cast<Map<String, dynamic>>()) : null, onError: (_) {});
    } else {
      _loadFees();
    }
  }

  Future<void> _loadFees() async {
    final r = await context.read<ApiClient>().get('/v1/fees?playerId=$_playerId&open=true') as List;
    if (mounted) setState(() => _fees = r.cast<Map<String, dynamic>>());
  }

  Future<void> _save() async {
    final amount = _rupeesIn(_amount);
    if (_playerId == null || amount == null || amount <= 0) return setState(() => _error = 'Choose the player and enter the amount.');
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().post('/v1/payments', {
        'playerId': _playerId,
        if (_feeId != null) 'feeId': _feeId,
        'amount': amount,
        'method': _method,
        'paidOn': _paidOn,
        if (_reference.text.trim().isNotEmpty) 'reference': _reference.text.trim(),
      });
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final fixedName = widget.playerName ?? widget.fee?['player_name'] as String?;
    return _FormPage(
      title: 'Record payment',
      busy: _busy,
      error: _error,
      onSave: _save,
      saveLabel: 'Save payment',
      children: [
        if (fixedName != null)
          InputDecorator(decoration: _field('Player'), child: Text(fixedName))
        else
          DropdownButtonFormField<String>(
            initialValue: _playerId,
            decoration: _field('Player'),
            items: [for (final p in _players ?? const <Map<String, dynamic>>[]) DropdownMenuItem(value: p['id'] as String, child: Text(p['full_name'] as String))],
            onChanged: (v) {
              setState(() {
                _playerId = v;
                _feeId = null;
                _fees = const [];
              });
              _loadFees();
            },
          ),
        if (_fees.isNotEmpty)
          DropdownButtonFormField<String?>(
            initialValue: _feeId,
            decoration: _field('Towards'),
            items: [
              const DropdownMenuItem<String?>(value: null, child: Text('No particular fee')),
              for (final f in _fees) DropdownMenuItem<String?>(value: f['id'] as String, child: Text('${f['description']} · ${formatRupees(f['balance_paise'] as num)} due')),
            ],
            onChanged: (v) => setState(() {
              _feeId = v;
              final f = _fees.where((f) => f['id'] == v).firstOrNull;
              if (f != null) _amount.text = _plain(f['balance_paise'] as num);
            }),
          ),
        TextField(controller: _amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: _field('Amount', prefix: '₹ ')),
        _MethodPicker(value: _method, onChanged: (m) => setState(() => _method = m)),
        _DateField(label: 'Received on', value: _paidOn, onChanged: (d) => setState(() => _paidOn = d)),
        TextField(controller: _reference, decoration: _field('Reference (optional)', helper: 'UPI transaction ID, cheque number or receipt number')),
      ],
    );
  }
}

String _plain(num paise) => paise % 100 == 0 ? '${paise ~/ 100}' : (paise / 100).toStringAsFixed(2);

/// Pay a coach for a month. Suggests what's still owed from their sessions.
class PayCoachScreen extends StatefulWidget {
  const PayCoachScreen({super.key, required this.month, this.coachId, this.suggested});
  final String month;
  final String? coachId;
  final num? suggested;
  @override
  State<PayCoachScreen> createState() => _PayCoachScreenState();
}

class _PayCoachScreenState extends State<PayCoachScreen> {
  late String? _coachId = widget.coachId;
  late final _amount = TextEditingController(text: (widget.suggested ?? 0) > 0 ? _plain(widget.suggested!) : '');
  final _reference = TextEditingController();
  String _method = 'bank';
  String _paidOn = today();
  bool _busy = false;
  String? _error;
  List<Map<String, dynamic>> _coaches = const [];

  @override
  void initState() {
    super.initState();
    context.read<ApiClient>().get('/v1/coach-rates').then((r) => mounted ? setState(() => _coaches = (r as List).cast<Map<String, dynamic>>()) : null, onError: (_) {});
  }

  Future<void> _save() async {
    final amount = _rupeesIn(_amount);
    if (_coachId == null || amount == null || amount <= 0) return setState(() => _error = 'Choose the coach and enter the amount.');
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().post('/v1/coach-payouts', {
        'coachId': _coachId,
        'amount': amount,
        'forMonth': widget.month,
        'paidOn': _paidOn,
        'method': _method,
        if (_reference.text.trim().isNotEmpty) 'reference': _reference.text.trim(),
      });
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => _FormPage(
        title: 'Pay a coach',
        busy: _busy,
        error: _error,
        onSave: _save,
        saveLabel: 'Save payout',
        children: [
          DropdownButtonFormField<String>(
            key: ValueKey(_coaches.length),
            initialValue: _coaches.any((c) => c['coach_id'] == _coachId) ? _coachId : null,
            decoration: _field('Coach'),
            items: [for (final c in _coaches) DropdownMenuItem(value: c['coach_id'] as String, child: Text(c['full_name'] as String))],
            onChanged: (v) => setState(() => _coachId = v),
          ),
          InputDecorator(decoration: _field('For'), child: Text(monthLabel(widget.month))),
          TextField(
            controller: _amount,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: _field('Amount', prefix: '₹ ', helper: (widget.suggested ?? 0) > 0 ? 'Still owed for ${monthLabel(widget.month)}: ${formatRupees(widget.suggested!)}' : null),
          ),
          _MethodPicker(value: _method, onChanged: (m) => setState(() => _method = m)),
          _DateField(label: 'Paid on', value: _paidOn, onChanged: (d) => setState(() => _paidOn = d)),
          TextField(controller: _reference, decoration: _field('Reference (optional)')),
        ],
      );
}

class AddExpenseScreen extends StatefulWidget {
  const AddExpenseScreen({super.key});
  @override
  State<AddExpenseScreen> createState() => _AddExpenseScreenState();
}

class _AddExpenseScreenState extends State<AddExpenseScreen> {
  final _description = TextEditingController();
  final _amount = TextEditingController();
  final _reference = TextEditingController();
  String _category = 'ground';
  String _method = 'cash';
  String _spentOn = today();
  bool _busy = false;
  String? _error;

  Future<void> _save() async {
    final amount = _rupeesIn(_amount);
    if (_description.text.trim().length < 2 || amount == null || amount <= 0) return setState(() => _error = 'Say what it was for and enter the amount.');
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().post('/v1/expenses', {
        'category': _category,
        'description': _description.text.trim(),
        'amount': amount,
        'spentOn': _spentOn,
        'method': _method,
        if (_reference.text.trim().isNotEmpty) 'reference': _reference.text.trim(),
      });
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => _FormPage(
        title: 'Add expense',
        busy: _busy,
        error: _error,
        onSave: _save,
        saveLabel: 'Save expense',
        children: [
          Wrap(spacing: 6, runSpacing: 6, children: [
            for (final c in expenseCategories) ChoiceChip(label: Text(humanise(c)), selected: _category == c, onSelected: (_) => setState(() => _category = c)),
          ]),
          TextField(controller: _description, decoration: _field('What for', helper: 'e.g. Ground hire, new balls, bowling machine repair')),
          TextField(controller: _amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: _field('Amount', prefix: '₹ ')),
          _MethodPicker(value: _method, onChanged: (m) => setState(() => _method = m)),
          _DateField(label: 'Spent on', value: _spentOn, onChanged: (d) => setState(() => _spentOn = d)),
          TextField(controller: _reference, decoration: _field('Reference (optional)')),
        ],
      );
}

// ---------------------------------------------------------------------------
// Lists

/// Payments, coach payouts or expenses for a month, with voiding.
class LedgerScreen extends StatelessWidget {
  const LedgerScreen({super.key, required this.month, required this.kind});
  final String month;
  final String kind; // payments | coach-payouts | expenses

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    final title = switch (kind) { 'payments' => 'Payments received', 'coach-payouts' => 'Coach payouts', _ => 'Expenses' };
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: OnlineLoader<List<dynamic>>(
        load: () async => await api.get('/v1/$kind?month=$month') as List<dynamic>,
        builder: (context, rows, reload) {
          if (rows.isEmpty) return EmptyState('Nothing recorded for ${monthLabel(month)}.', icon: Icons.receipt_long_outlined);
          final live = rows.cast<Map<String, dynamic>>().where((r) => r['voided_at'] == null).fold<num>(0, (a, r) => a + (r['amount_paise'] as num));
          return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
            SectionHeader('${monthLabel(month)} · ${formatRupees(live)}', padding: const EdgeInsets.fromLTRB(16, 4, 16, 6)),
            GroupCard(children: [
              for (final r in rows.cast<Map<String, dynamic>>()) _LedgerRow(kind: kind, r: r, reload: reload),
            ]),
          ]);
        },
      ),
    );
  }
}

class _LedgerRow extends StatelessWidget {
  const _LedgerRow({required this.kind, required this.r, required this.reload});
  final String kind;
  final Map<String, dynamic> r;
  final Future<void> Function() reload;

  @override
  Widget build(BuildContext context) {
    final voided = r['voided_at'] != null;
    final title = switch (kind) {
      'payments' => r['player_name'] as String,
      'coach-payouts' => r['coach_name'] as String,
      _ => r['description'] as String,
    };
    final when = (r['paid_on'] ?? r['spent_on']) as String;
    final detail = [
      shortDay(when),
      methodLabel(r['method'] as String),
      if (kind == 'payments' && r['fee_description'] != null) r['fee_description'] as String,
      if (kind == 'expenses') humanise(r['category'] as String),
      if (r['reference'] != null) r['reference'] as String,
      if (voided) 'Voided: ${r['void_reason']}',
    ].join(' · ');
    final strike = voided ? const TextStyle(decoration: TextDecoration.lineThrough) : null;
    return ListTile(
      title: Text(title, style: strike),
      subtitle: Text(detail),
      trailing: Text(formatRupees(r['amount_paise'] as num), style: Theme.of(context).textTheme.titleSmall?.merge(strike)),
      onLongPress: voided ? null : () => _void(context),
      onTap: voided ? null : () => _void(context),
    );
  }

  Future<void> _void(BuildContext context) async {
    final reason = await askText(context, title: 'Void this entry?', label: 'Why (kept on record)', action: 'Void');
    if (reason == null || reason.length < 3 || !context.mounted) return;
    try {
      await context.read<ApiClient>().post('/v1/$kind/${r['id']}/void', {'reason': reason});
      await reload();
    } catch (e) {
      if (context.mounted) showMessage(context, e);
    }
  }
}

/// Every fee not yet paid in full, oldest first.
class OutstandingFeesScreen extends StatelessWidget {
  const OutstandingFeesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return Scaffold(
      appBar: AppBar(title: const Text('Fees to collect')),
      body: OnlineLoader<List<dynamic>>(
        load: () async => await api.get('/v1/fees?open=true') as List<dynamic>,
        builder: (context, rows, reload) {
          if (rows.isEmpty) return const EmptyState('Every fee is paid.', icon: Icons.check_circle_outline);
          final fees = rows.cast<Map<String, dynamic>>().reversed.toList();
          return ListView(padding: const EdgeInsets.only(top: 4, bottom: 24), children: [
            GroupCard(children: [for (final f in fees) FeeTile(fee: f, reload: reload, showPlayer: true)]),
          ]);
        },
      ),
    );
  }
}

/// One fee with what's paid and what's left. Tap to record a payment against it.
class FeeTile extends StatelessWidget {
  const FeeTile({super.key, required this.fee, required this.reload, this.showPlayer = false});
  final Map<String, dynamic> fee;
  final Future<void> Function() reload;
  final bool showPlayer;

  @override
  Widget build(BuildContext context) {
    final f = fee;
    final status = f['status'] as String;
    final tone = switch (status) { 'paid' => 'good', 'overdue' => 'bad', 'part_paid' => 'warn', _ => 'neutral' };
    final open = (f['balance_paise'] as num) > 0;
    return ListTile(
      title: Text(showPlayer ? '${f['player_name']}' : f['description'] as String),
      subtitle: Text([
        if (showPlayer) f['description'] as String,
        'Due ${shortDay(f['due_on'] as String)}',
        if ((f['paid_paise'] as num) > 0 && open) '${formatRupees(f['paid_paise'] as num)} paid',
        if (status == 'waived') 'Waived: ${f['waive_reason']}',
      ].join(' · ')),
      trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
        Text(formatRupees(open ? f['balance_paise'] as num : f['amount_paise'] as num), style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 2),
        Pill.tone(context, humanise(status), tone),
      ]),
      onTap: open ? () => _actions(context) : null,
    );
  }

  Future<void> _actions(BuildContext context) async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(leading: const Icon(Icons.payments_outlined), title: const Text('Record a payment'), onTap: () => Navigator.pop(ctx, 'pay')),
          ListTile(leading: const Icon(Icons.money_off), title: const Text('Waive what is left'), onTap: () => Navigator.pop(ctx, 'waive')),
        ]),
      ),
    );
    if (!context.mounted) return;
    if (choice == 'pay') {
      if (await _open<bool>(context, RecordPaymentScreen(fee: fee)) == true) await reload();
    } else if (choice == 'waive') {
      final reason = await askText(context, title: 'Waive this fee?', label: 'Why (kept on record)', action: 'Waive');
      if (reason == null || reason.length < 3 || !context.mounted) return;
      try {
        await context.read<ApiClient>().post('/v1/fees/${fee['id']}/waive', {'reason': reason});
        await reload();
      } catch (e) {
        if (context.mounted) showMessage(context, e);
      }
    }
  }
}

/// Fees for one player, shown on the admin's player page.
String _hours(num h) => h == h.roundToDouble() ? '${h.round()}' : h.toStringAsFixed(1);

/// Whether the academy coaches this player for free. Their sessions still count
/// in the month report, but no fees are expected from them.
class FreeCoachingTile extends StatefulWidget {
  const FreeCoachingTile({super.key, required this.playerId, required this.free, this.reason});
  final String playerId;
  final bool free;
  final String? reason;
  @override
  State<FreeCoachingTile> createState() => _FreeCoachingTileState();
}

class _FreeCoachingTileState extends State<FreeCoachingTile> {
  late bool _free = widget.free;
  late String? _reason = widget.reason;
  bool _busy = false;

  Future<void> _set(bool free) async {
    String? reason;
    if (free) {
      final field = TextEditingController();
      reason = await showDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Coach for free'),
          content: TextField(controller: field, autofocus: true, decoration: const InputDecoration(labelText: 'Why (optional)', hintText: 'e.g. Scholarship')),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(context, field.text.trim()), child: const Text('Save')),
          ],
        ),
      );
      if (reason == null || !mounted) return;
    }
    setState(() => _busy = true);
    try {
      final r = await context.read<ApiClient>().put('/v1/players/${widget.playerId}/free-coaching', {'free': free, 'reason': (reason ?? '').isEmpty ? null : reason});
      setState(() {
        _free = r['free_coaching'] as bool;
        _reason = r['free_reason'] as String?;
      });
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => GroupCard(margin: const EdgeInsets.only(top: 18), children: [
        SwitchListTile(
          secondary: const Icon(Icons.volunteer_activism_outlined),
          title: const Text('Coached for free'),
          subtitle: Text(_free ? (_reason ?? 'No fees expected') : 'Turn on for scholarships or players you don\'t charge'),
          value: _free,
          onChanged: _busy ? null : _set,
        ),
      ]);
}

class PlayerFeesCard extends StatelessWidget {
  const PlayerFeesCard({super.key, required this.playerId, required this.playerName});
  final String playerId;
  final String playerName;

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return _Reloadable<List<dynamic>>(
      load: () async => await api.get('/v1/fees?playerId=$playerId') as List<dynamic>,
      builder: (context, rows, reload) {
        final fees = rows.cast<Map<String, dynamic>>();
        final due = fees.fold<num>(0, (a, f) => a + (f['balance_paise'] as num));
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          SectionHeader(due > 0 ? 'Fees · ${formatRupees(due)} due' : 'Fees', padding: const EdgeInsets.fromLTRB(4, 18, 4, 6)),
          GroupCard(margin: EdgeInsets.zero, children: [
            if (fees.isEmpty) const ListTile(title: Text('No fees yet'), subtitle: Text('A fee is added when a priced package is given, or add one here.')),
            for (final f in fees.take(8)) FeeTile(fee: f, reload: reload),
          ]),
          const SizedBox(height: 6),
          Wrap(spacing: 8, children: [
            TextButton.icon(
              icon: const Icon(Icons.add),
              label: const Text('Add fee'),
              onPressed: () async {
                if (await _open<bool>(context, AddFeeScreen(playerId: playerId)) == true) await reload();
              },
            ),
            TextButton.icon(
              icon: const Icon(Icons.payments_outlined),
              label: const Text('Record payment'),
              onPressed: () async {
                if (await _open<bool>(context, RecordPaymentScreen(playerId: playerId, playerName: playerName)) == true) await reload();
              },
            ),
          ]),
        ]);
      },
    );
  }
}

class AddFeeScreen extends StatefulWidget {
  const AddFeeScreen({super.key, required this.playerId});
  final String playerId;
  @override
  State<AddFeeScreen> createState() => _AddFeeScreenState();
}

class _AddFeeScreenState extends State<AddFeeScreen> {
  final _description = TextEditingController(text: 'Monthly fee ${DateFormat('MMMM').format(DateTime.now())}');
  final _amount = TextEditingController();
  String _dueOn = today();
  bool _busy = false;
  String? _error;

  Future<void> _save() async {
    final amount = _rupeesIn(_amount);
    if (_description.text.trim().length < 2 || amount == null || amount <= 0) return setState(() => _error = 'Say what the fee is for and enter the amount.');
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().post('/v1/players/${widget.playerId}/fees', {'description': _description.text.trim(), 'amount': amount, 'dueOn': _dueOn});
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => _FormPage(
        title: 'Add fee',
        busy: _busy,
        error: _error,
        onSave: _save,
        saveLabel: 'Add fee',
        children: [
          TextField(controller: _description, decoration: _field('What for')),
          TextField(controller: _amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: _field('Amount', prefix: '₹ ')),
          _DateField(label: 'Due on', value: _dueOn, onChanged: (d) => setState(() => _dueOn = d)),
        ],
      );
}

/// What each coach is paid per session: a default, and optionally a
/// different rate for particular kinds of session.
class CoachRatesScreen extends StatelessWidget {
  const CoachRatesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return Scaffold(
      appBar: AppBar(title: const Text('Coach pay rates')),
      body: OnlineLoader<(List<dynamic>, List<dynamic>)>(
        load: () async => (await api.get('/v1/coach-rates') as List<dynamic>, await api.get('/v1/categories') as List<dynamic>),
        builder: (context, data, reload) {
          final (rates, cats) = data;
          return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: Text('Pay is worked out from the sessions each coach took in the month. A rate for a kind of session overrides the coach\'s default.'),
            ),
            GroupCard(children: [
              for (final r in rates.cast<Map<String, dynamic>>())
                ListTile(
                  leading: Avatar(r['full_name'] as String),
                  title: Text(r['full_name'] as String),
                  subtitle: Text([
                    r['default_paise'] == null ? 'No default rate' : '${formatRupees(r['default_paise'] as num)} a session',
                    for (final c in (r['by_category'] as List).cast<Map<String, dynamic>>()) '${c['name']}: ${formatRupees(c['amount_paise'] as num)}',
                  ].join('\n')),
                  trailing: const Icon(Icons.edit_outlined),
                  onTap: () async {
                    if (await _open<bool>(context, _EditRatesScreen(coach: r, categories: cats.cast<Map<String, dynamic>>())) == true) await reload();
                  },
                ),
            ]),
          ]);
        },
      ),
    );
  }
}

class _EditRatesScreen extends StatefulWidget {
  const _EditRatesScreen({required this.coach, required this.categories});
  final Map<String, dynamic> coach;
  final List<Map<String, dynamic>> categories;
  @override
  State<_EditRatesScreen> createState() => _EditRatesScreenState();
}

class _EditRatesScreenState extends State<_EditRatesScreen> {
  late final _default = TextEditingController(text: widget.coach['default_paise'] == null ? '' : _plain(widget.coach['default_paise'] as num));
  late final Map<String, TextEditingController> _byCat = {
    for (final c in widget.categories)
      c['id'] as String: TextEditingController(
        text: (() {
          final r = (widget.coach['by_category'] as List).cast<Map<String, dynamic>>().where((x) => x['categoryId'] == c['id']).firstOrNull;
          return r == null ? '' : _plain(r['amount_paise'] as num);
        })(),
      ),
  };
  bool _busy = false;
  String? _error;

  Future<void> _save() async {
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().put('/v1/coaches/${widget.coach['coach_id']}/rates', {
        'default': _rupeesIn(_default),
        'byCategory': [
          for (final e in _byCat.entries)
            if (_rupeesIn(e.value) != null) {'categoryId': e.key, 'amount': _rupeesIn(e.value)},
        ],
      });
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => _FormPage(
        title: widget.coach['full_name'] as String,
        busy: _busy,
        error: _error,
        onSave: _save,
        saveLabel: 'Save rates',
        children: [
          TextField(controller: _default, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: _field('Default, per session', prefix: '₹ ')),
          Text('Different rate for a kind of session (leave blank to use the default)', style: Theme.of(context).textTheme.bodySmall),
          for (final c in widget.categories)
            TextField(controller: _byCat[c['id']], keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: _field(c['name'] as String, prefix: '₹ ')),
        ],
      );
}

/// Like OnlineLoader but sized to its content, for use inside another list.
class _Reloadable<T> extends StatefulWidget {
  const _Reloadable({required this.load, required this.builder});
  final Future<T> Function() load;
  final Widget Function(BuildContext context, T data, Future<void> Function() reload) builder;
  @override
  State<_Reloadable<T>> createState() => _ReloadableState<T>();
}

class _ReloadableState<T> extends State<_Reloadable<T>> {
  T? _data;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    try {
      final d = await widget.load();
      if (mounted) setState(() => _data = d);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_data == null) return Padding(padding: const EdgeInsets.all(16), child: Text(_error == null ? 'Loading fees…' : 'Fees need a connection.'));
    return widget.builder(context, _data as T, _reload);
  }
}
