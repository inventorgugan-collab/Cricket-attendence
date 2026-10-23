import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class Tokens {
  const Tokens(this.accessToken, this.refreshToken, this.academy);
  final String accessToken;
  final String refreshToken;

  /// The academy code these tokens belong to. Every academy is separate.
  final String academy;
}

abstract class TokenStore {
  Future<Tokens?> read();
  Future<void> write(Tokens tokens);
  Future<void> clear();

  /// The academy code last signed in to on this phone, kept after sign-out.
  Future<String?> lastAcademy();
}

/// Keychain on iOS, Keystore-backed encrypted storage on Android.
class SecureTokenStore implements TokenStore {
  SecureTokenStore([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();
  final FlutterSecureStorage _storage;

  @override
  Future<Tokens?> read() async {
    final access = await _storage.read(key: 'access_token');
    final refresh = await _storage.read(key: 'refresh_token');
    final academy = await _storage.read(key: 'academy');
    if (access == null || refresh == null || academy == null) return null;
    return Tokens(access, refresh, academy);
  }

  @override
  Future<void> write(Tokens tokens) async {
    await _storage.write(key: 'access_token', value: tokens.accessToken);
    await _storage.write(key: 'refresh_token', value: tokens.refreshToken);
    await _storage.write(key: 'academy', value: tokens.academy);
  }

  @override
  Future<void> clear() async {
    await _storage.delete(key: 'access_token');
    await _storage.delete(key: 'refresh_token');
    // The academy code is kept so the next sign-in on this phone is pre-filled.
  }

  @override
  Future<String?> lastAcademy() => _storage.read(key: 'academy');
}

class MemoryTokenStore implements TokenStore {
  Tokens? _tokens;
  @override
  Future<Tokens?> read() async => _tokens;
  @override
  Future<void> write(Tokens tokens) async {
    _tokens = tokens;
    _academy = tokens.academy;
  }
  @override
  Future<void> clear() async => _tokens = null;
  String? _academy;
  @override
  Future<String?> lastAcademy() async => _academy ?? _tokens?.academy;
}
