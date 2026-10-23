import 'package:sqflite_common/sqlite_api.dart';
import 'package:sqflite_common_ffi_web/sqflite_ffi_web.dart';

/// Browser preview only. Browser storage is not encrypted, so the web build is
/// for demonstrations and staff testing, not for real player data.
Future<Database> openPlatformDb(String key, OnDatabaseCreateFn onCreate) {
  return databaseFactoryFfiWeb.openDatabase('cpl.db', options: OpenDatabaseOptions(version: 1, onCreate: onCreate));
}
