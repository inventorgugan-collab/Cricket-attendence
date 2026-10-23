import 'package:cpl_mobile/core/config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a typed server address becomes a full one', () {
    expect(AppConfig.normaliseServer(' 192.168.1.5 '), 'http://192.168.1.5:3000');
    expect(AppConfig.normaliseServer('192.168.1.5:8080/'), 'http://192.168.1.5:8080');
    expect(AppConfig.normaliseServer('https://cpl-api.onrender.com/'), 'https://cpl-api.onrender.com');
    expect(AppConfig.normaliseServer(''), '');
  });
}
