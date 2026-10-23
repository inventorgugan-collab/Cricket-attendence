import 'dart:convert';

import 'package:http/http.dart' as http;

import 'token_store.dart';

class ApiException implements Exception {
  ApiException(this.statusCode, this.code, this.message, [this.details]);
  final int statusCode;
  final String code;
  final String message;
  final Object? details;

  @override
  String toString() => message;
}

/// Thrown when the server can't be reached. Callers treat this as "offline".
class OfflineException implements Exception {
  OfflineException(this.cause);
  final Object cause;
  @override
  String toString() => 'No connection to the academy server';
}

class ApiClient {
  ApiClient({required this.baseUrl, required this.tokens, http.Client? client}) : _http = client ?? http.Client();

  /// Can be changed on the sign-in screen, e.g. to a computer on the same Wi-Fi.
  String baseUrl;
  final TokenStore tokens;
  final http.Client _http;

  /// Called when the session can no longer be refreshed (e.g. account deactivated).
  void Function()? onSignedOut;

  Future<dynamic> get(String path) => _send('GET', path);
  Future<dynamic> post(String path, [Object? body]) => _send('POST', path, body);
  Future<dynamic> put(String path, [Object? body]) => _send('PUT', path, body);
  Future<dynamic> patch(String path, [Object? body]) => _send('PATCH', path, body);

  /// The academy's name for a code, or null if there's no such academy.
  Future<String?> academyName(String code) async {
    final res = await _raw('GET', '/v1/academies/${Uri.encodeComponent(code)}', null, null);
    if (res.statusCode == 404) return null;
    return (_decode(res) as Map<String, dynamic>)['name'] as String?;
  }

  Future<Map<String, dynamic>> login(String academy, String login, String password) async {
    final res = await _raw('POST', '/v1/auth/login', {'academy': academy, 'login': login, 'password': password}, null);
    final body = _decode(res) as Map<String, dynamic>;
    await tokens.write(Tokens(body['accessToken'] as String, body['refreshToken'] as String, academy));
    return body['user'] as Map<String, dynamic>;
  }

  Future<void> logout() async {
    final t = await tokens.read();
    await tokens.clear();
    if (t != null) {
      try {
        await _raw('POST', '/v1/auth/logout', {'academy': t.academy, 'refreshToken': t.refreshToken}, null);
      } catch (_) {
        // Signing out locally is what matters; the server token expires on its own.
      }
    }
  }

  Future<dynamic> _send(String method, String path, [Object? body]) async {
    var t = await tokens.read();
    var res = await _raw(method, path, body, t?.accessToken);
    if (res.statusCode == 401 && t != null && await _refresh(t)) {
      t = await tokens.read();
      res = await _raw(method, path, body, t?.accessToken);
    }
    if (res.statusCode == 401) {
      await tokens.clear();
      onSignedOut?.call();
    }
    return _decode(res);
  }

  Future<bool> _refresh(Tokens t) async {
    final res = await _raw('POST', '/v1/auth/refresh', {'academy': t.academy, 'refreshToken': t.refreshToken}, null);
    if (res.statusCode != 200) return false;
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    await tokens.write(Tokens(body['accessToken'] as String, body['refreshToken'] as String, t.academy));
    return true;
  }

  Future<http.Response> _raw(String method, String path, Object? body, String? accessToken) async {
    final req = http.Request(method, Uri.parse('$baseUrl$path'));
    req.headers['accept'] = 'application/json';
    if (accessToken != null) req.headers['authorization'] = 'Bearer $accessToken';
    if (body != null) {
      req.headers['content-type'] = 'application/json';
      req.body = jsonEncode(body);
    }
    try {
      final streamed = await _http.send(req).timeout(const Duration(seconds: 20));
      return await http.Response.fromStream(streamed);
    } catch (e) {
      throw OfflineException(e);
    }
  }

  dynamic _decode(http.Response res) {
    final body = res.body.isEmpty ? null : jsonDecode(res.body);
    if (res.statusCode >= 200 && res.statusCode < 300) return body;
    final err = body is Map ? body['error'] as Map<String, dynamic>? : null;
    throw ApiException(res.statusCode, err?['code'] as String? ?? 'error', err?['message'] as String? ?? 'Request failed (${res.statusCode})', err?['details']);
  }
}
