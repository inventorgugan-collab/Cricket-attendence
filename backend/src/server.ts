import { buildApp } from './app.js';
import { config } from './config.js';
import { migrateAll } from './migrate.js';

await migrateAll();
const app = await buildApp({ logger: true });
await app.listen({ port: config.port, host: '0.0.0.0' });

// Sends queued WhatsApp messages and each academy's end-of-day coach summary.
const { whatsappTick } = await import('./modules/whatsapp.js');
let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await whatsappTick();
  } finally {
    ticking = false;
  }
}, 60_000);
