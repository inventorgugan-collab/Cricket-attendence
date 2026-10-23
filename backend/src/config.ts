function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL', isProduction ? undefined : 'postgres://cpl:cpl@localhost/cpl_dev'),
  jwtSecret: required('JWT_SECRET', isProduction ? undefined : 'dev-only-secret-change-me-dev-only-secret'),
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlDays: 30,
  // The academy's local time zone, used for "today", daily and monthly reports.
  timeZone: process.env.ACADEMY_TIME_ZONE ?? 'Asia/Kolkata',
  // The platform owner's key for adding academies. Unset means the API for it is off.
  platformKey: process.env.PLATFORM_KEY ?? null,
  // Encrypts stored WhatsApp access tokens. Required in production.
  messagingKey: process.env.MESSAGING_KEY ?? (isProduction ? undefined : 'dev-only-messaging-key'),
  whatsappApiBase: process.env.WHATSAPP_API_BASE ?? 'https://graph.facebook.com/v23.0',
};
