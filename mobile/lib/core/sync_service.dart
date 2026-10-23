import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import 'api.dart';
import 'local_db.dart';

enum SyncState { idle, syncing, offline, error }

/// Offline-first changes. Every change is written to the device first, together
/// with an outbox entry, in one local transaction. Sync then sends the outbox in
/// order and pulls whatever changed on the server. The server is the authority:
/// if it rejects a change or holds it as a conflict, the device shows the
/// server's version and lists the problem for the user.
class SyncService extends ChangeNotifier {
  SyncService(this.api, this.local);

  final ApiClient api;
  final LocalDb local;
  static const _uuid = Uuid();

  SyncState state = SyncState.idle;
  DateTime? lastSyncedAt;
  int pending = 0;
  int problems = 0;
  String? lastError;

  Future<void> refreshCounts() async {
    pending = await local.outboxCount('pending');
    problems = await local.outboxCount('conflict') + await local.outboxCount('rejected');
    final last = await local.meta('last_synced_at');
    lastSyncedAt = last == null ? null : DateTime.parse(last);
    notifyListeners();
  }

  // ------------------------------------------------------------ local edits
  Future<void> markAttendance({required String sessionId, required String playerId, required String status, String? note, bool walkIn = false}) async {
    final existing = await local.attendanceFor(sessionId, playerId);
    final serverVersion = existing?['pending'] == true ? existing!['base_version'] : existing?['version'];
    await local.db.transaction((txn) async {
      await txn.delete('records', where: 'kind = ? AND session_id = ? AND player_id = ?', whereArgs: [Kind.attendance, sessionId, playerId]);
      await local.upsert(txn, Kind.attendance, {
        ...?existing,
        'id': existing?['id'] ?? 'local-${_uuid.v4()}',
        'session_id': sessionId,
        'player_id': playerId,
        'status': status,
        'note': note,
        'original_status': existing?['original_status'] ?? status,
        'recorded_at': DateTime.now().toUtc().toIso8601String(),
        'pending': true,
        'base_version': serverVersion,
      });
      await local.enqueue(txn, id: _uuid.v4(), type: 'attendance.mark', payload: {
        'sessionId': sessionId,
        'playerId': playerId,
        'status': status,
        if (note != null && note.isNotEmpty) 'note': note,
        'baseVersion': ?serverVersion,
        if (walkIn) 'walkIn': true,
        'recordedAt': DateTime.now().toUtc().toIso8601String(),
      });
    });
    await _afterLocalChange();
  }

  Future<void> setSessionStatus(String sessionId, String status) async {
    final session = await local.get(Kind.session, sessionId);
    await local.db.transaction((txn) async {
      if (session != null) await local.upsert(txn, Kind.session, {...session, 'status': status, 'pending': true});
      await local.enqueue(txn, id: _uuid.v4(), type: 'session.status', payload: {'sessionId': sessionId, 'status': status});
    });
    await _afterLocalChange();
  }

  /// [note] uses the server's field names (camelCase) and must include an `id`.
  Future<void> saveCoachNote(Map<String, dynamic> note) => _saveVersioned(Kind.coachNote, 'coach_note.upsert', note);

  Future<void> saveJournal(Map<String, dynamic> entry) => _saveVersioned(Kind.journal, 'journal.upsert', entry);

  Future<void> _saveVersioned(String kind, String type, Map<String, dynamic> record) async {
    final existing = await local.get(kind, record['id'] as String);
    final baseVersion = existing == null ? null : (existing['pending'] == true ? existing['baseVersion'] : existing['version']);
    final payload = Map<String, dynamic>.from(record)
      ..removeWhere((k, v) => const {'version', 'pending', 'baseVersion', 'createdAt', 'updatedAt', 'coachName', 'coachId'}.contains(k));
    if (baseVersion != null) payload['baseVersion'] = baseVersion;
    await local.db.transaction((txn) async {
      await local.upsert(txn, kind, {...?existing, ...record, 'pending': true, 'baseVersion': baseVersion});
      await local.enqueue(txn, id: _uuid.v4(), type: type, payload: payload);
    });
    await _afterLocalChange();
  }

  /// Offline booking requests are only requests: they show as "waiting to send"
  /// and the server decides them when they arrive.
  Future<void> requestBooking({required String sessionId, required String playerId}) async {
    final id = _uuid.v4();
    await local.db.transaction((txn) async {
      await local.upsert(txn, Kind.booking, {'id': 'local-$id', 'session_id': sessionId, 'player_id': playerId, 'status': 'queued', 'pending': true});
      await local.enqueue(txn, id: id, type: 'booking.request', payload: {'sessionId': sessionId, 'playerId': playerId});
    });
    await _afterLocalChange();
  }

  Future<void> _afterLocalChange() async {
    await refreshCounts();
    // Try straight away; if there is no signal the change simply waits.
    unawaited(sync());
  }

  // ------------------------------------------------------------------- sync
  Future<void>? _current;
  bool _again = false;

  /// Runs a sync. If one is already running, waits for it and then runs once
  /// more, so a change made mid-sync is never left behind.
  Future<void> sync() async {
    if (_current != null) {
      _again = true;
      return _current;
    }
    final run = () async {
      do {
        _again = false;
        await _syncOnce();
      } while (_again && state != SyncState.offline);
    }();
    _current = run;
    try {
      await run;
    } finally {
      _current = null;
    }
  }

  Future<void> _syncOnce() async {
    state = SyncState.syncing;
    notifyListeners();
    try {
      final allSent = await _push();
      // Only pull once our own changes are in, so the pull can't hide them.
      if (allSent) await _pull();
      state = SyncState.idle;
      lastError = null;
    } on OfflineException {
      state = SyncState.offline;
    } on ApiException catch (e) {
      state = SyncState.error;
      lastError = e.message;
    } finally {
      await refreshCounts();
    }
  }

  Future<bool> _push() async {
    while (true) {
      final batch = (await local.outbox()).take(50).toList();
      if (batch.isEmpty) return true;
      final res = await api.post('/v1/sync/push', {
        'mutations': [
          for (final m in batch)
            {'id': m['id'], 'type': m['type'], 'clientTime': m['client_time'], 'payload': jsonDecode(m['payload'] as String)},
        ],
      }) as Map<String, dynamic>;
      final byId = {for (final m in batch) m['id']: m};
      await local.db.transaction((txn) async {
        for (final r in (res['results'] as List).cast<Map<String, dynamic>>()) {
          final m = byId[r['id']]!;
          final payload = jsonDecode(m['payload'] as String) as Map<String, dynamic>;
          final outcome = r['outcome'] as String;
          await txn.update('outbox', {'status': outcome == 'applied' ? 'done' : outcome, 'result': jsonEncode(r), 'attempts': (m['attempts'] as int) + 1}, where: 'id = ?', whereArgs: [m['id']]);
          await _applyResult(txn, m['type'] as String, payload, r);
        }
      });
    }
  }

  Future<void> _applyResult(dynamic txn, String type, Map<String, dynamic> payload, Map<String, dynamic> r) async {
    final outcome = r['outcome'];
    switch (type) {
      case 'attendance.mark':
        await txn.delete('records', where: 'kind = ? AND session_id = ? AND player_id = ?', whereArgs: [Kind.attendance, payload['sessionId'], payload['playerId']]);
        final server = outcome == 'applied' ? r['attendance'] : r['server'];
        if (server != null) await local.upsert(txn, Kind.attendance, Map<String, dynamic>.from(server as Map));
      case 'coach_note.upsert':
      case 'journal.upsert':
        final kind = type == 'journal.upsert' ? Kind.journal : Kind.coachNote;
        final server = outcome == 'applied' ? r['record'] : r['server'];
        if (server != null) {
          await local.upsert(txn, kind, Map<String, dynamic>.from(server as Map));
        } else if (outcome == 'rejected') {
          await txn.delete('records', where: 'kind = ? AND id = ?', whereArgs: [kind, payload['id']]);
        }
      case 'booking.request':
        final localId = 'local-${r['id']}';
        await txn.delete('records', where: 'kind = ? AND id = ?', whereArgs: [Kind.booking, localId]);
        if (r['booking'] != null) await local.upsert(txn, Kind.booking, Map<String, dynamic>.from(r['booking'] as Map));
      case 'session.status':
        break; // The next pull brings the session's new state.
    }
  }

  Future<void> _pull() async {
    final cursor = await local.meta('cursor');
    final res = await api.get('/v1/sync/pull${cursor == null ? '' : '?cursor=${Uri.encodeQueryComponent(cursor)}'}') as Map<String, dynamic>;
    List<Map<String, dynamic>> rows(String key) => (res[key] as List).cast<Map<String, dynamic>>();
    await local.db.transaction((txn) async {
      if (res['full'] == true) {
        await txn.delete('records', where: "kind IN (${List.filled(Kind.all.length, '?').join(', ')})", whereArgs: Kind.all);
      }
      for (final s in rows('sessions')) {
        await local.upsert(txn, Kind.session, s);
      }
      for (final b in rows('bookings')) {
        await local.upsert(txn, Kind.booking, b);
      }
      for (final a in rows('attendance')) {
        // A newer server record replaces any local placeholder for the same player.
        await txn.delete('records', where: 'kind = ? AND session_id = ? AND player_id = ? AND id <> ?', whereArgs: [Kind.attendance, a['session_id'], a['player_id'], a['id']]);
        await local.upsert(txn, Kind.attendance, a);
      }
      for (final p in rows('players')) {
        await local.upsert(txn, Kind.player, p);
      }
      for (final i in rows('injuries')) {
        await local.upsert(txn, Kind.injury, i);
      }
      for (final n in rows('coachNotes')) {
        await local.upsert(txn, Kind.coachNote, n);
      }
      for (final j in rows('journal')) {
        await local.upsert(txn, Kind.journal, j);
      }
      for (final id in (res['removedSessionIds'] as List).cast<String>()) {
        await txn.delete('records', where: 'kind = ? AND id = ?', whereArgs: [Kind.session, id]);
        await txn.delete('records', where: 'kind IN (?, ?) AND session_id = ?', whereArgs: [Kind.booking, Kind.attendance, id]);
      }
      // Keep the device lean: drop finished outbox entries and old sessions.
      await txn.delete('outbox', where: "status = 'done'");
      final cutoff = DateTime.now().toUtc().subtract(const Duration(days: 45)).toIso8601String();
      await txn.delete('records', where: 'kind = ? AND sort_key < ?', whereArgs: [Kind.session, cutoff]);
      await local.setMeta(txn, 'cursor', res['cursor'] as String);
      await local.setMeta(txn, 'last_synced_at', DateTime.now().toUtc().toIso8601String());
    });
  }

  /// Changes the server refused or held for review, newest first.
  Future<List<Map<String, dynamic>>> problemsList() async {
    final rows = await local.outbox(statuses: const ['conflict', 'rejected']);
    return [
      for (final r in rows.reversed)
        {
          'id': r['id'],
          'type': r['type'],
          'status': r['status'],
          'payload': jsonDecode(r['payload'] as String),
          'result': r['result'] == null ? null : jsonDecode(r['result'] as String),
          'clientTime': r['client_time'],
        },
    ];
  }

  Future<void> dismissProblem(String id) async {
    await local.db.update('outbox', {'status': 'dismissed'}, where: 'id = ?', whereArgs: [id]);
    await refreshCounts();
  }
}
