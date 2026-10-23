// End-to-end check of the offline flow against a running API server.
// Start the server with seed data, then:
//   flutter test test/offline_sync_test.dart --dart-define=E2E_API=http://localhost:3100
@TestOn('vm')
library;

import 'dart:io';

import 'package:cpl_mobile/core/api.dart';
import 'package:cpl_mobile/core/local_db.dart';
import 'package:cpl_mobile/core/sync_service.dart';
import 'package:cpl_mobile/core/token_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

const api = String.fromEnvironment('E2E_API');
const academy = String.fromEnvironment('E2E_ACADEMY', defaultValue: 'cpl');
const password = String.fromEnvironment('E2E_PASSWORD', defaultValue: 'devpass123');

/// An HTTP client whose "signal" can be switched off, like a phone at the nets.
class FlakyClient extends http.BaseClient {
  final _inner = http.Client();
  bool online = true;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    if (!online) throw const SocketException('No route to host');
    return _inner.send(request);
  }
}

Future<(SyncService, FlakyClient, ApiClient)> device(String login) async {
  final net = FlakyClient();
  final client = ApiClient(baseUrl: api, tokens: MemoryTokenStore(), client: net);
  await client.login(academy, login, password);
  final local = await LocalDb.openWith(databaseFactoryFfi, inMemoryDatabasePath);
  return (SyncService(client, local), net, client);
}

void main() {
  sqfliteFfiInit();

  test('coach marks attendance offline and it reaches the server once', () async {
    final (sync, net, client) = await device('arun');
    await sync.sync();
    expect(sync.state, SyncState.idle);
    final sessions = await sync.local.list(Kind.session);
    final today = sessions.firstWhere((s) => s['title'] == 'U16 batting');
    final bookings = await sync.local.list(Kind.booking, sessionId: today['id'] as String);
    expect(bookings, hasLength(2));
    final players = await sync.local.list(Kind.player);
    expect(players.every((p) => !p.containsKey('address')), isTrue, reason: 'coaches never get home addresses');

    // Lose signal, mark the register, write a note.
    net.online = false;
    for (final b in bookings) {
      await sync.markAttendance(sessionId: today['id'] as String, playerId: b['player_id'] as String, status: 'present');
    }
    await sync.saveCoachNote({'id': '6f1c1f3e-2d43-4a8f-9b0e-1c6a3d6f2b11', 'sessionId': today['id'], 'objectives': 'Front-foot drives'});
    await sync.sync();
    expect(sync.state, SyncState.offline);
    expect(sync.pending, 3);
    final local = await sync.local.attendanceFor(today['id'] as String, bookings.first['player_id'] as String);
    expect(local!['pending'], isTrue);

    // Signal returns.
    net.online = true;
    await sync.sync();
    expect(sync.pending, 0);
    expect(sync.problems, 0);
    final server = await client.get('/v1/sessions/${today['id']}') as Map<String, dynamic>;
    expect((server['attendance'] as List).map((a) => a['status']), everyElement('present'));
    final synced = await sync.local.attendanceFor(today['id'] as String, bookings.first['player_id'] as String);
    expect(synced!['pending'], isNull);
    expect(synced['version'], 1);

    // Sending again changes nothing on the server.
    await sync.sync();
    final again = await client.get('/v1/sessions/${today['id']}') as Map<String, dynamic>;
    expect(again['attendance'], hasLength(2));
  });

  test('an admin override made while the coach is offline wins until resolved', () async {
    final (coach, net, _) = await device('arun');
    final (admin, _, adminApi) = await device('admin');
    await coach.sync();
    final today = (await coach.local.list(Kind.session)).firstWhere((s) => s['title'] == 'U16 batting');
    final att = (await coach.local.list(Kind.attendance, sessionId: today['id'] as String)).first;

    net.online = false;
    await coach.markAttendance(sessionId: today['id'] as String, playerId: att['player_id'] as String, status: 'late', note: 'Arrived 6:20');
    await adminApi.post('/v1/attendance/${att['id']}/override', {'status': 'excused', 'reason': 'School trip letter'});
    net.online = true;
    await coach.sync();

    expect(coach.problems, 1);
    final shown = await coach.local.attendanceFor(today['id'] as String, att['player_id'] as String);
    expect(shown!['status'], 'excused', reason: 'the device shows the server version, not the stale edit');
    final problems = await coach.problemsList();
    expect(problems.single['status'], 'conflict');
    final conflicts = await adminApi.get('/v1/sync/conflicts') as List;
    expect(conflicts, hasLength(1));
    await admin.local.db.close();
  });

  test('a player journal entry written offline syncs and a parent can read it', () async {
    final (player, net, _) = await device('ravi');
    final me = await player.api.get('/v1/me') as Map<String, dynamic>;
    net.online = false;
    await player.saveJournal({
      'id': '0b8c3a52-6c1e-4c66-9f0a-8f5d6a1e2c34',
      'playerId': me['profileId'],
      'entryDate': '2026-10-22',
      'skills': 'Pull shot',
      'volume': {'balls': 90},
      'wentWell': 'Weight transfer',
    });
    net.online = true;
    await player.sync();
    expect(player.pending, 0);
    expect(player.problems, 0);
    final (parent, _, parentApi) = await device('lakshmi');
    final journal = await parentApi.get('/v1/players/${me['profileId']}/journal') as List;
    expect(journal.single['skills'], 'Pull shot');
    await parent.local.db.close();
  });
}
