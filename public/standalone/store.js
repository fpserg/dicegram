// Storage for the serverless app. Two backends with one interface:
//   shared — the claude.ai artifact database: live multiplayer across devices
//   local  — this browser only (localStorage), for opening the page anywhere else
// Documents live at "collection/id" paths.

const LOCAL_PREFIX = 'dicegram:';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TAB = Math.random().toString(36).slice(2);

export async function openStore() {
  const claude = window.claude;
  if (claude?.use) {
    const [db, user] = await Promise.all([claude.use('db'), claude.use('user')]);
    const id = user ? await user.id() : null;
    if (db && id) return sharedStore(db, user, id);
  }
  return localStore();
}

function sharedStore(db, user, uid) {
  const plain = (snap) => (snap.exists ? structuredClone(snap.data()) : null);
  return {
    mode: 'shared',
    uid,
    // Organizer tools for the artifact's owner; invited players only play.
    isAdmin: () => user.isOwner(),
    defaultName: async () => (await user.me()).name || '',
    watchDoc(path, cb, onError) {
      return db.doc(path).onSnapshot((s) => cb(plain(s)), onError);
    },
    watchCol(path, cb, onError) {
      return db.collection(path).onSnapshot((q) => cb(q.docs.map((d) => ({ id: d.id, ...structuredClone(d.data()) }))), onError);
    },
    async get(path) { return plain(await db.doc(path).get()); },
    set: (path, data) => db.doc(path).set(data),
    del: (path) => db.doc(path).delete(),
    // Short cooperative lease so two players never overwrite each other's move.
    async lock(path) {
      for (let i = 0; i < 12; i++) {
        const r = await db.doc(path).acquire({ holder: `${uid}:${TAB}`, ttlMs: 1500 });
        if (r.acquired) return;
        const wait = r.expiresAt ? Date.parse(r.expiresAt) - Date.now() : 300;
        await sleep(Math.min(1500, Math.max(80, wait)) + Math.random() * 120);
      }
      throw new Error('The game is busy — try again');
    },
  };
}

function localStore() {
  const read = (path) => {
    try { const v = localStorage.getItem(LOCAL_PREFIX + path); return v ? JSON.parse(v) : null; } catch { return null; }
  };
  const keys = (col) => {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(`${LOCAL_PREFIX}${col}/`) && !k.slice(LOCAL_PREFIX.length + col.length + 1).includes('/')) out.push(k.slice(LOCAL_PREFIX.length));
      }
    } catch { /* storage blocked: behave as empty */ }
    return out;
  };
  const listeners = new Set(); // {path, isCol, cb}
  const notify = (path) => {
    const col = path.slice(0, path.lastIndexOf('/'));
    for (const l of listeners) {
      if (l.isCol ? l.path === col : l.path === path) l.fire();
    }
  };
  window.addEventListener('storage', (e) => { if (e.key?.startsWith(LOCAL_PREFIX)) notify(e.key.slice(LOCAL_PREFIX.length)); });

  let uid = null;
  try {
    uid = localStorage.getItem(`${LOCAL_PREFIX}uid`);
    if (!uid) { uid = `local-${Math.random().toString(36).slice(2, 10)}`; localStorage.setItem(`${LOCAL_PREFIX}uid`, uid); }
  } catch { uid = 'local-guest'; }

  const watch = (path, isCol, cb) => {
    const l = { path, isCol, fire: () => cb(isCol ? keys(path).map((k) => ({ id: k.split('/').pop(), ...read(k) })) : read(path)) };
    listeners.add(l);
    queueMicrotask(l.fire);
    return () => listeners.delete(l);
  };
  return {
    mode: 'local',
    uid,
    isAdmin: async () => true,
    defaultName: async () => '',
    watchDoc: (path, cb) => watch(path, false, cb),
    watchCol: (path, cb) => watch(path, true, cb),
    async get(path) { return read(path); },
    async set(path, data) {
      try { localStorage.setItem(LOCAL_PREFIX + path, JSON.stringify(data)); } catch { throw new Error('This browser blocks local storage'); }
      notify(path);
    },
    async del(path) { try { localStorage.removeItem(LOCAL_PREFIX + path); } catch { /* ignore */ } notify(path); },
    async lock() {},
  };
}
