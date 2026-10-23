// npm run academy:create -- <code> "<name>" <admin login> <temporary password>
import { closeAllPools } from './db.js';
import { migratePlatform } from './migrate.js';
import { createAcademy, newAcademy } from './modules/academies.js';

const [code, name, adminLogin, adminPassword] = process.argv.slice(2);
try {
  await migratePlatform();
  const a = await createAcademy(newAcademy.parse({ code, name, adminLogin, adminPassword }));
  console.log(`Created ${a.name} (code ${a.code}). The admin signs in as ${adminLogin} and must change the password.`);
} finally {
  await closeAllPools();
}
