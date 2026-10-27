// Shared player/library storage contract. Writes are synchronous at lifecycle boundaries so
// navigating back or closing a tab does not drop the last session.
const ACTIVITY = 'gamebox.activity.v1';
const ACHIEVEMENTS = 'gamebox.achievements.v1';
function read(storage, key) {
  try { const data = JSON.parse(storage.getItem(key) || '{}'); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; } catch { return {}; }
}
function write(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
// The player shows a notice for each newly unlocked id.
function announce(game, ids) {
  if (ids.length) globalThis.dispatchEvent?.(new CustomEvent('gamebox-achievement', { detail: { game, ids } }));
}
export function createActivityTracker(game, { storage = globalThis.localStorage, clock = () => performance.now(), now = () => Date.now(), id = globalThis.crypto.randomUUID(), map } = {}) {
  let started = false, stopped = false, activeSince = null, seconds = 0, start = 0;
  function checkpoint() {
    if (!started || stopped) return;
    if (activeSince !== null) {
      const time = clock(); seconds += Math.max(0, time - activeSince) / 1000; activeSince = time;
    }
    const data = read(storage, ACTIVITY);
    const current = data[game] || { seconds: 0, last: 0, sessions: [] };
    const sessions = Array.isArray(current.sessions) ? current.sessions : [];
    const previous = sessions.find(s => s.id === id);
    const session = { id, start, seconds, ...(map ? { map } : {}) };
    data[game] = {
      ...current,
      seconds: Math.max(0, (current.seconds || 0) + seconds - (previous?.seconds || 0)),
      last: Math.max(current.last || 0, now()),
      ...(map ? { lastMap: map } : {}),
      sessions: [session, ...sessions.filter(s => s.id !== id)].slice(0, 50),
    };
    write(storage, ACTIVITY, data);
  }
  return {
    start() { if (started || stopped) return; started = true; start = now(); activeSince = clock(); checkpoint(); },
    checkpoint,
    pause() { if (activeSince === null) return; checkpoint(); activeSince = null; },
    resume() { if (started && !stopped && activeSince === null) activeSince = clock(); },
    setMap(next) { if (next && next !== map) { map = next; checkpoint(); } },
    stop() { if (stopped) return; checkpoint(); stopped = true; activeSince = null; },
  };
}

// Source's CAchievementMgr serializes numeric ids, achieved flags and counts in GameState.txt.
// Preserve its original text as well, so the engine restores its own component bitsets next run.
export function syncSourceAchievements(game, source, storage = globalThis.localStorage, now = Date.now()) {
  if (!/^\s*"?GameState"?\s*\{/i.test(source)) throw new Error('Invalid Source achievement save');
  const data = read(storage, ACHIEVEMENTS);
  const previous = data[game] || { entries: {} };
  const entries = { ...previous.entries };
  for (const block of source.matchAll(/\{([^{}]*)\}/g)) {
    const fields = Object.fromEntries([...block[1].matchAll(/"([^"]+)"\s*"([^"]*)"/g)].map(m => [m[1], m[2]]));
    if (!/^\d+$/.test(fields.id || '')) continue;
    const unlocked = fields.value === '1';
    const prior = entries[fields.id];
    entries[fields.id] = {
      unlocked: unlocked || !!prior?.unlocked,
      count: Math.max(0, Number(fields.data) || 0),
      ...(prior?.unlockedAt ? { unlockedAt: prior.unlockedAt } : unlocked ? { unlockedAt: now } : {}),
    };
  }
  write(storage, ACHIEVEMENTS, { ...data, [game]: { source, entries } });
  announce(game, Object.keys(entries).filter(id => entries[id].unlocked && !previous.entries?.[id]?.unlocked));
}

// For games that report a set of unlocked achievement names (Terraria).
export function syncUnlockedAchievements(game, unlocked, storage = globalThis.localStorage, now = Date.now()) {
  const data = read(storage, ACHIEVEMENTS);
  const previous = data[game] || { entries: {} };
  const entries = { ...previous.entries };
  const fresh = [...unlocked].filter(id => !entries[id]?.unlocked);
  for (const id of fresh) entries[id] = { unlocked: true, count: 1, unlockedAt: now };
  if (!fresh.length) return;
  write(storage, ACHIEVEMENTS, { ...data, [game]: { ...previous, entries } });
  announce(game, fresh);
}

export function attachSourceAchievements(FS, game, mod, storage = globalThis.localStorage) {
  const paths = [`/${mod}/gamestate.txt`, `/${mod}/GameState.txt`];
  const previous = read(storage, ACHIEVEMENTS)[game]?.source;
  FS.mkdirTree(`/${mod}`);
  // A valid empty file also lets CAchievementMgr mark global state as loaded on
  // first launch, instead of repeatedly failing to open a dangling link.
  FS.writeFile(paths[0], previous || '"GameState"\n{\n}\n');
  // Linux MEMFS is case-sensitive; Source versions use both spellings.
  if (FS.symlink) {
    try { FS.symlink(paths[0], paths[1]); } catch { /* Existing game file. */ }
  } else if (previous) FS.writeFile(paths[1], previous);
  let last = previous;
  let capturing = false;
  const capture = path => {
    if (capturing || !path || !/\/gamestate\.txt$/i.test(path)) return;
    capturing = true;
    try {
      const text = FS.readFile(path, { encoding: 'utf8' });
      if (text !== last) { syncSourceAchievements(game, text, storage); last = text; }
    } catch { /* The engine can probe or replace the file while writing. */ }
    finally { capturing = false; }
  };
  const close = FS.close, rename = FS.rename;
  const wrappedClose = function(stream, ...args) {
    const path = stream.path || (stream.node && FS.getPath(stream.node));
    const result = close.call(this, stream, ...args); capture(path); return result;
  };
  const wrappedRename = function(from, to, ...args) { const result = rename.call(this, from, to, ...args); capture(to); return result; };
  FS.close = wrappedClose; FS.rename = wrappedRename;
  return {
    capture() { capture(paths[0]); },
    dispose() { if (FS.close === wrappedClose) FS.close = close; if (FS.rename === wrappedRename) FS.rename = rename; },
  };
}
