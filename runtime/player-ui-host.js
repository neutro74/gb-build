// Small player-side adapter. The full shared menus load only when first requested.
export function installPlayerUI({ canvas, game, name, onLeave, onSettings, AudioContext: NativeAudioContext }) {
  let api, importing, opened = false;
  const held = new Map(), swallowed = new Set();
  const rawPads = navigator.getGamepads?.bind(navigator) ?? (() => []);
  const read = () => { try { return JSON.parse(localStorage.getItem('gamebox.settings.v1') || '{}'); } catch { return {}; } };
  let preferences = read();
  window.addEventListener('storage', () => { preferences = read(); });
  window.addEventListener('focus', () => { preferences = read(); });
  const style = document.createElement('style');
  style.textContent = `
    #gamebox-controls{position:fixed;inset:12px 12px auto;z-index:45;display:flex;justify-content:space-between;pointer-events:none}
    #gamebox-controls button{width:38px;height:32px;display:grid;place-items:center;padding:0;border:1px solid #ffffff26;border-radius:7px;background:#10151cd9;color:#eef1f5;opacity:.22;pointer-events:auto;transition:opacity .22s,background .15s;box-shadow:0 2px 8px #0003}
    #gamebox-controls.revealed button,#gamebox-controls button:hover,#gamebox-controls button:focus-visible{opacity:1;background:#202733}
    #gamebox-controls button:focus-visible{outline:1px solid #68bfff;outline-offset:3px}
    :root[data-gamebox-overlay='open'] #gamebox-controls,:root[data-gamebox-locked='true'] #gamebox-controls{visibility:hidden;pointer-events:none}
    #gamebox-ui-status{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:46;padding:8px 14px;border-radius:6px;background:#151b24;color:#dfe5ee;font:12px/1.5 system-ui;pointer-events:none}
  `;
  document.head.append(style);
  const controls = document.createElement('div');
  controls.id = 'gamebox-controls';
  controls.innerHTML = '<button type="button" aria-label="Main menu" title="Main menu (Ctrl+M)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button><button type="button" aria-label="Quick Access" title="Quick Access (Ctrl+.)"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="#10151c"/><circle cx="15" cy="17" r="2.5" fill="#10151c"/></svg></button>';
  document.body.append(controls);
  const status = document.createElement('div'); status.id = 'gamebox-ui-status'; status.hidden = true; document.body.append(status);
  let fading;
  const reveal = () => { controls.classList.add('revealed'); clearTimeout(fading); fading = setTimeout(() => controls.classList.remove('revealed'), 1800); };
  reveal();
  window.addEventListener('pointermove', e => { if (!document.pointerLockElement && e.clientY < 66) reveal(); }, { passive: true });
  document.addEventListener('pointerlockchange', () => { document.documentElement.dataset.gameboxLocked = String(!!document.pointerLockElement); if (!document.pointerLockElement) reveal(); });

  function state(active) {
    document.documentElement.dataset.gameboxOverlay = active ? 'open' : 'closed';
    if (opened === active) return;
    if (active) {
      // Release buttons before isolating input, so a held movement key never sticks.
      for (const data of held.values()) canvas.dispatchEvent(new KeyboardEvent('keyup', { ...data, bubbles: true }));
      held.clear();
      for (let button = 0; button < 3; button++) canvas.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true }));
      if (document.pointerLockElement) document.exitPointerLock();
      navigator.keyboard?.unlock?.();
    }
    opened = active;
    canvas.inert = active;
    if (!active) { canvas.focus({ preventScroll: true }); reveal(); }
  }
  document.documentElement.dataset.gameboxOverlay = 'closed';
  // Engine listeners on document/window must not see pointer events from the UI.
  // The generated UI marks its synchronous registration phase; later key-capture
  // controls use listen() below. Keep removeEventListener's identity semantics.
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  const listeners = new WeakMap();
  const inputEvent = /^(mouse|pointer|touch|wheel|contextmenu|click|dblclick)/;
  const capture = options => typeof options === 'boolean' ? options : !!options?.capture;
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (listener && inputEvent.test(type) && (this === window || this === document || this === canvas) && !window.gameboxUIRegistering) {
      let map = listeners.get(this); if (!map) listeners.set(this, map = new Map());
      let entries = map.get(listener); if (!entries) map.set(listener, entries = new Map());
      const key = `${type}:${capture(options)}`;
      if (!entries.has(key)) entries.set(key, function(event) {
        if (opened || controls.contains(event.target)) return;
        if (typeof listener === 'function') listener.call(this, event); else listener.handleEvent(event);
      });
      return nativeAdd.call(this, type, entries.get(key), options);
    }
    return nativeAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    const mapped = listeners.get(this)?.get(listener)?.get(`${type}:${capture(options)}`);
    return nativeRemove.call(this, type, mapped || listener, options);
  };

  // Engines poll controllers independently of DOM input. UI navigation uses rawPads.
  if (navigator.getGamepads) {
    const muted = pad => pad && new Proxy(pad, { get(target, prop) {
      if (prop === 'buttons') return target.buttons.map(() => ({ pressed: false, touched: false, value: 0 }));
      if (prop === 'axes') return target.axes.map(() => 0);
      return Reflect.get(target, prop, target);
    } });
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => opened ? [...rawPads()].map(muted) : rawPads() });
  }
  // Keep menus above engines that request fullscreen on the canvas itself.
  const nativeFullscreen = Element.prototype.requestFullscreen;
  if (nativeFullscreen) Element.prototype.requestFullscreen = function(options) {
    return nativeFullscreen.call(this === canvas ? document.documentElement : this, options);
  };
  async function fullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  }
  function screenshot() {
    try { const a = document.createElement('a'); a.download = `${game}-${Date.now()}.png`; a.href = canvas.toDataURL('image/png'); a.click(); }
    catch { status.textContent = 'The game did not expose a screenshot.'; status.hidden = false; setTimeout(() => status.hidden = true, 3500); }
  }
  window.gameboxPlayer = {
    game, name, state, fullscreen, screenshot, AudioContext: NativeAudioContext,
    getGamepads: rawPads,
    navigate(route) { api?.navigate(route); },
    leave: onLeave,
    settingsChanged() { preferences = read(); onSettings(); },
    previewCloak() { window.dispatchEvent(new Event('gamebox-preview-cloak')); },
    resume() { api?.close(); },
    listen(target, type, listener, options) {
      nativeAdd.call(target, type, listener, options);
      return () => nativeRemove.call(target, type, listener, options);
    },
    ready(value) { api = value; },
  };
  async function load() {
    if (api) return api;
    if (!importing) importing = import('./game-ui.js').then(() => {
      if (!api) throw new Error('Menu bundle did not initialize.');
      return api;
    }).catch(error => { importing = null; throw error; });
    return importing;
  }
  async function open(panel) {
    try {
      state(true);
      if (!api) { status.textContent = 'Opening menu…'; status.hidden = false; }
      const ui = await load();
      ui.open(panel);
      status.hidden = true;
    } catch (error) {
      state(false); status.textContent = 'Menu could not load. Try again.'; status.hidden = false;
      console.error('GameBox menu:', error);
      setTimeout(() => status.hidden = true, 4000);
    }
  }
  controls.children[0].addEventListener('click', () => open('menu'));
  controls.children[1].addEventListener('click', () => open('quick'));
  const combo = e => [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', e.code].filter(Boolean).join('+');
  const defaults = { menu: 'Ctrl+KeyM', quick: 'Ctrl+Period', fullscreen: 'Ctrl+Shift+KeyF', screenshot: 'Ctrl+Shift+KeyS', perf: 'Ctrl+Shift+KeyP' };
  window.addEventListener('keydown', e => {
    if (opened) {
      swallowed.add(e.code); e.stopImmediatePropagation(); api?.keydown(e); return;
    }
    if (swallowed.has(e.code)) { e.stopImmediatePropagation(); e.preventDefault(); return; }
    const shortcuts = { ...defaults, ...preferences.shortcuts };
    const action = Object.keys(defaults).find(key => shortcuts[key] === combo(e));
    if (action) {
      swallowed.add(e.code); e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat) return;
      if (action === 'menu' || action === 'quick') void open(action);
      else if (action === 'fullscreen') void fullscreen();
      else if (action === 'screenshot') screenshot();
      else void load().then(ui => ui.keydown(e));
      return;
    }
    held.set(e.code, { key: e.key, code: e.code, keyCode: e.keyCode, which: e.which });
  }, true);
  window.addEventListener('keyup', e => {
    held.delete(e.code);
    const consumed = swallowed.delete(e.code);
    if (opened || consumed) e.stopImmediatePropagation();
  }, true);
  // Guide and Select+Start remain available while gameplay owns the controller.
  let guideHeld = false;
  function poll() {
    requestAnimationFrame(poll);
    if (opened || api || preferences.pad?.enabled === false) return;
    const down = [...rawPads()].some(p => p && (p.buttons[16]?.pressed || (p.buttons[8]?.pressed && p.buttons[9]?.pressed)));
    if (down && !guideHeld) void open('menu');
    guideHeld = down;
  }
  requestAnimationFrame(poll);
  return { open, isOpen: () => opened };
}
