import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 3000);
const adminToken = process.env.ADMIN_TOKEN || 'admin';
const devFaucet = process.env.DEV_FAUCET !== '0';

const { server } = createApp({
  dbFile: process.env.DB_FILE || path.join(root, 'data', 'db.json'),
  adminToken,
  devFaucet,
});

server.listen(port, () => {
  console.log(`DiceGram running:  player app http://localhost:${port}/   admin app http://localhost:${port}/admin`);
  if (!process.env.ADMIN_TOKEN) console.warn('ADMIN_TOKEN not set — using "admin". Set it before exposing this server.');
  if (devFaucet) console.warn('Test GRAM faucet is ON (DEV_FAUCET=0 to disable).');
});
