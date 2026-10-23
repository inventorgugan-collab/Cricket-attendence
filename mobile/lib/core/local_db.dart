import 'dart:convert';
import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:sqflite_common/sqlite_api.dart';
import 'package:sqflite_common/utils/utils.dart' as utils;

import 'local_db_open_io.dart' if (dart.library.js_interop) 'local_db_open_web.dart';

/// Kinds of server records kept on the device for offline use.
class Kind {
  static const session = 'session';
  static const booking = 'booking';
  static const attendance = 'attendance';
  static const player = 'player';
  static const injury = 'injury';
  static const coachNote = 'coach_note';
  static const journal = 'journal';
  static const all = [session, booking, attendance, player, injury, coachNote, journal];
}

/// The device's copy of the user's data plus the queue of changes waiting to
/// be sent. On phones the file is encrypted with SQLCipher, keyed by a random
/// secret held in the Keychain / Android Keystore.
class LocalDb {
  LocalDb(this.db);
  final Database db;

  static const _schema = [
    '''CREATE TABLE IF NOT EXISTS records (
         kind TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT, player_id TEXT, sort_key TEXT,
         data TEXT NOT NULL, PRIMARY KEY (kind, id))''',
    'CREATE INDEX IF NOT EXISTS records_session ON records(kind, session_id)',
    'CREATE INDEX IF NOT EXISTS records_player ON records(kind, player_id)',
    '''CREATE TABLE IF NOT EXISTS outbox (
         id TEXT PRIMARY KEY, seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
         client_time TEXT NOT NULL, status TEXT NOT NULL, result TEXT, attempts INTEGER NOT NULL DEFAULT 0)''',
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)',
  ];

  static Future<LocalDb> openEncrypted({FlutterSecureStorage storage = const FlutterSecureStorage()}) async {
    var key = await storage.read(key: 'local_db_key');
    if (key == null) {
      final rnd = Random.secure();
      key = base64UrlEncode(List<int>.generate(32, (_) => rnd.nextInt(256)));
      await storage.write(key: 'local_db_key', value: key);
    }
    return LocalDb(await openPlatformDb(key, _create));
  }

  static Future<void> _create(Database db, int version) async {
    for (final s in _schema) {
      await db.execute(s);
    }
  }

  /// For tests and tooling: any sqflite factory (e.g. the FFI in-memory one).
  static Future<LocalDb> openWith(DatabaseFactory factory, String path) async {
    final db = await factory.openDatabase(path, options: OpenDatabaseOptions(version: 1, onCreate: (db, _) async {
      for (final s in _schema) {
        await db.execute(s);
      }
    }));
    return LocalDb(db);
  }

  // ---------------------------------------------------------------- records
  static String? _sortKey(String kind, Map<String, dynamic> r) => switch (kind) {
        Kind.session => r['starts_at'] as String?,
        Kind.journal => r['entry_date'] as String? ?? r['entryDate'] as String?,
        Kind.coachNote => r['createdAt'] as String?,
        Kind.player => r['full_name'] as String?,
        _ => null,
      };

  Future<void> upsert(DatabaseExecutor ex, String kind, Map<String, dynamic> r) async {
    await ex.insert(
      'records',
      {
        'kind': kind,
        'id': r['id'],
        'session_id': r['session_id'] ?? r['sessionId'],
        'player_id': r['player_id'] ?? r['playerId'],
        'sort_key': _sortKey(kind, r),
        'data': jsonEncode(r),
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<List<Map<String, dynamic>>> list(String kind, {String? sessionId, String? playerId, bool descending = false}) async {
    final where = <String>['kind = ?'];
    final args = <Object?>[kind];
    if (sessionId != null) {
      where.add('session_id = ?');
      args.add(sessionId);
    }
    if (playerId != null) {
      where.add('player_id = ?');
      args.add(playerId);
    }
    final rows = await db.query('records', where: where.join(' AND '), whereArgs: args, orderBy: 'sort_key ${descending ? 'DESC' : 'ASC'}');
    return rows.map((r) => jsonDecode(r['data'] as String) as Map<String, dynamic>).toList();
  }

  Future<Map<String, dynamic>?> get(String kind, String id) async {
    final rows = await db.query('records', where: 'kind = ? AND id = ?', whereArgs: [kind, id]);
    return rows.isEmpty ? null : jsonDecode(rows.first['data'] as String) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>?> attendanceFor(String sessionId, String playerId) async {
    final rows = await db.query('records', where: 'kind = ? AND session_id = ? AND player_id = ?', whereArgs: [Kind.attendance, sessionId, playerId]);
    return rows.isEmpty ? null : jsonDecode(rows.first['data'] as String) as Map<String, dynamic>;
  }

  // ----------------------------------------------------------------- outbox
  Future<void> enqueue(DatabaseExecutor ex, {required String id, required String type, required Map<String, dynamic> payload}) async {
    final seq = utils.firstIntValue(await ex.rawQuery('SELECT coalesce(max(seq), 0) + 1 FROM outbox')) ?? 1;
    await ex.insert('outbox', {
      'id': id,
      'seq': seq,
      'type': type,
      'payload': jsonEncode(payload),
      'client_time': DateTime.now().toUtc().toIso8601String(),
      'status': 'pending',
    });
  }

  Future<List<Map<String, Object?>>> outbox({List<String> statuses = const ['pending']}) =>
      db.query('outbox', where: 'status IN (${List.filled(statuses.length, '?').join(', ')})', whereArgs: statuses, orderBy: 'seq');

  Future<int> outboxCount(String status) async =>
      utils.firstIntValue(await db.rawQuery('SELECT count(*) FROM outbox WHERE status = ?', [status])) ?? 0;

  // ------------------------------------------------------------------- meta
  Future<String?> meta(String key) async {
    final rows = await db.query('meta', where: 'key = ?', whereArgs: [key]);
    return rows.isEmpty ? null : rows.first['value'] as String?;
  }

  Future<void> setMeta(DatabaseExecutor ex, String key, String? value) =>
      ex.insert('meta', {'key': key, 'value': value}, conflictAlgorithm: ConflictAlgorithm.replace);

  /// Sign-out wipes everything, including unsent changes (the user is warned first).
  Future<void> wipe() async {
    await db.delete('records');
    await db.delete('outbox');
    await db.delete('meta');
  }
}
