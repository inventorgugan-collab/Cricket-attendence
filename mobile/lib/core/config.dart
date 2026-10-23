/// Build-time settings. Pass `--dart-define=API_BASE_URL=https://...` for real builds.
class AppConfig {
  static const apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:3000');
  /// Turns what someone typed ("192.168.1.5", "https://x.com/") into a server address.
  static String normaliseServer(String input) {
    var url = input.trim();
    while (url.endsWith('/')) {
      url = url.substring(0, url.length - 1);
    }
    if (url.isEmpty) return url;
    if (!url.contains('://')) url = 'http://$url';
    final uri = Uri.tryParse(url);
    // A bare address on the local network means the server's default port.
    if (uri != null && uri.scheme == 'http' && !uri.hasPort) url = uri.replace(port: 3000).toString();
    return url;
  }

  static const syncInterval = Duration(minutes: 2);
}
