/// Build-time settings. Pass `--dart-define=API_BASE_URL=https://...` for real builds.
class AppConfig {
  static const apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:3000');
  static const syncInterval = Duration(minutes: 2);
}
