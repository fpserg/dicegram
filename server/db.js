// Tiny JSON-file store. The whole state lives in memory and is written
// atomically (tmp file + rename) after every mutation. Good enough for a
// prototype with a single server process; swap for a real DB before launch.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
export const newToken = () => crypto.randomBytes(24).toString('base64url');

function empty() {
  return { users: {}, boards: {}, games: {}, ledger: [], withdrawals: [] };
}

export function openDb(file) {
  let data = empty();
  if (file && fs.existsSync(file)) data = { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  return {
    data,
    save() {
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    },
  };
}
