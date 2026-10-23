import 'package:path/path.dart' as p;
import 'package:sqflite_common/sqlite_api.dart';
import 'package:sqflite_sqlcipher/sqflite.dart' as cipher;

/// Phones: SQLCipher-encrypted file in the app's private storage.
Future<Database> openPlatformDb(String key, OnDatabaseCreateFn onCreate) async {
  final path = p.join(await cipher.getDatabasesPath(), 'cpl.db');
  return cipher.openDatabase(path, password: key, version: 1, onCreate: onCreate);
}
