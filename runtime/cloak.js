// Shared by the bundled launcher and the standalone game player. No runtime network assets.
import { presetIcons } from './cloak-icons.js';
import { renderCloakBackground } from './cloak-backgrounds.js';
export const CLOAK_PRESETS = {
  google: { label: 'Google', title: 'Google', color: '#4285f4', glyph: 'G' },
  classroom: { label: 'Google Classroom', title: 'Google Classroom', color: '#0f9d58', glyph: '' },
  mcps: { label: 'myMCPS Classroom (Canvas)', title: 'Dashboard', color: '#e03c31', glyph: '' },
  docs: { label: 'Google Docs', title: 'Google Docs', color: '#4285f4', glyph: '' },
  drive: { label: 'Google Drive', title: 'My Drive - Google Drive', color: '#0f9d58', glyph: '' },
  gmail: { label: 'Gmail', title: 'Gmail', color: '#ea4335', glyph: 'M' },
  notes: { label: 'Notes', title: 'Notes', color: '#d4a72c', glyph: '▤' },
  documents: { label: 'Documents', title: 'Documents', color: '#4285f4', glyph: '▤' },
  calendar: { label: 'Calendar', title: 'Calendar', color: '#348853', glyph: '31' },
  blank: { label: 'Blank tab', title: 'New Tab', color: '#777777', glyph: '' },
  custom: { label: 'Custom', title: 'Notes', color: '#777777', glyph: '▤' },
};
export const CLOAK_DEFAULTS = { mode: 'off', preset: 'google', title: 'Google', icon: '', cover: true, coverPreset: 'auto', coverText: 'Notes', coverColor: '#f3f1e9', coverImage: '' };
const svgData = svg => `data:image/svg+xml;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(svg)))}`;
const imageData = value => typeof value === 'string' && value.length <= 1600000 && /^data:image\/(png|jpeg|webp|gif|x-icon|vnd.microsoft.icon|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/.test(value);
export function normalizeCloak(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: ['off', 'always', 'away'].includes(s.mode) ? s.mode : 'off',
    preset: Object.hasOwn(CLOAK_PRESETS, s.preset) ? s.preset : 'google',
    title: typeof s.title === 'string' ? s.title.slice(0, 120) : CLOAK_DEFAULTS.title,
    icon: imageData(s.icon) ? s.icon : '',
    cover: typeof s.cover === 'boolean' ? s.cover : true,
    // Preserve existing custom covers, but migrate the old untouched Notes placeholder.
    coverPreset: s.coverPreset === 'auto' || Object.hasOwn(CLOAK_PRESETS, s.coverPreset) ? s.coverPreset
      : s.coverImage || (typeof s.coverText === 'string' && s.coverText !== 'Notes') || (s.coverColor && s.coverColor !== '#f3f1e9') ? 'custom' : 'auto',
    coverText: typeof s.coverText === 'string' ? s.coverText.slice(0, 160) : CLOAK_DEFAULTS.coverText,
    coverColor: /^#[\da-f]{6}$/i.test(s.coverColor) ? s.coverColor : CLOAK_DEFAULTS.coverColor,
    coverImage: imageData(s.coverImage) ? s.coverImage : '',
  };
}
export function cloakIdentity(raw) {
  const s = normalizeCloak(raw), preset = CLOAK_PRESETS[s.preset];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="4" y="4" width="56" height="56" rx="10" fill="${preset.color}"/><text x="32" y="45" text-anchor="middle" font-family="sans-serif" font-size="36" fill="white">${preset.glyph}</text></svg>`;
  const presetIcon = presetIcons[s.preset] || svgData(svg);
  return { title: s.preset === 'custom' ? s.title.trim() || 'Notes' : preset.title, icon: s.preset === 'custom' && s.icon ? s.icon : presetIcon };
}
export function createTabCloak({ title = document.title, icon = document.querySelector('link[rel="icon"]')?.href || '' } = {}) {
  let config = normalizeCloak(null), baseIcon = icon, away = document.hidden || !document.hasFocus();
  let preview = false, previewTimer;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
  const cover = document.createElement('div');
  cover.id = 'tab-cover';
  cover.setAttribute('aria-label', 'Tab cover');
  cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:none;place-items:center;background-position:center;background-size:cover;color:#283128;font:500 clamp(24px,4vw,48px)/1.4 system-ui,sans-serif;letter-spacing:-.03em;text-align:center;overflow:hidden;padding:32px;box-sizing:border-box;';
  document.body.append(cover);
  let appearance = '';
  function apply() {
    const enabled = config.mode !== 'off';
    const active = enabled && (config.mode === 'always' || away || preview);
    const identity = cloakIdentity(config);
    document.title = active ? identity.title : title;
    const nextIcon = active ? identity.icon : baseIcon;
    // Replacing the favicon's href (and MIME type) makes Chrome update the actual tab.
    link.removeAttribute('type');
    if (nextIcon) link.href = nextIcon; else link.removeAttribute('href');
    const covered = enabled && config.cover && (away || preview);
    cover.style.display = covered ? 'grid' : 'none';
    const nextAppearance = JSON.stringify([config.coverPreset, config.preset, config.coverColor, config.coverImage, config.coverText]);
    if (nextAppearance !== appearance) {
      renderCloakBackground(cover, config);
      appearance = nextAppearance;
    }
    document.documentElement.dataset.cloaked = String(active);
  }
  const blur = () => { away = true; apply(); };
  const focus = () => { away = document.hidden; preview = false; clearTimeout(previewTimer); apply(); };
  const visibility = () => { away = document.hidden || !document.hasFocus(); apply(); };
  window.addEventListener('blur', blur);
  window.addEventListener('focus', focus);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pageshow', visibility);
  cover.addEventListener('click', focus);
  return {
    update(raw, defaultIcon) { config = normalizeCloak(raw); if (defaultIcon !== undefined) baseIcon = defaultIcon; apply(); },
    preview() { preview = true; apply(); clearTimeout(previewTimer); previewTimer = setTimeout(() => { preview = false; apply(); }, 3000); },
  };
}
