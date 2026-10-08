// Single-page UI. No build step and no framework: the whole app is a small
// state object, a hash router and a handful of render functions.
//
// Layout: an app bar, the library (or a sign-in screen) under it, one panel
// ("sheet") at a time over the right edge — game, sync or settings — and the
// queue bar floating at the bottom. Each part has its own render function, so
// a queue update does not redraw the library and a click in a panel keeps its
// scroll position.

const state = {
  status: null,
  settings: null,
  games: [],
  query: '',
  sortBy: 'title',     // title | added | size
  sortDirection: 'asc',
  jobs: [],
  queueOpen: false,
  logs: new Map(),     // job id -> { text, fetchedAt } for jobs whose output is open
  detail: null,        // { game, groups, extras, platforms, languages }
  selection: null,     // { selected:Set, anchor:string|null, extras:bool, platforms:Set, languages:Set }
  failedCovers: new Set(), // gog ids whose cover image did not load
  syncMode: 'incremental',
  syncSearchTerm: '',
  cli: { releases: null, selected: '', checking: false },
  emailLoginOpen: false,
  // Used before sign-in, when the server settings cannot be read yet.
  localTheme: 'system',
};

// ---------------------------------------------------------------- constants

// Fallback cover background colours, six per set. The initials on them are always black.
const COVER_SETS = {
  bright: ['#ff5a36', '#2f5bff', '#ffc93c', '#0f7a50', '#b387ff', '#ff8fb1'],
  muted: ['#c8735a', '#5a72b0', '#d4a73c', '#3f7a5e', '#9d8ec2', '#c98a99'],
  earthy: ['#a65e46', '#6b7f99', '#c49a4a', '#5d6e4a', '#8a7a9a', '#b98b7a'],
  pastel: ['#e8b4a0', '#a9bde0', '#ecd79a', '#a8cdb4', '#cbbfe3', '#e8c1cc'],
  mono: ['#d9d4c7', '#bfb9ab', '#a39d90', '#8a857a', '#6f6b62', '#55524b'],
};
// Accent colours offered in Settings > Appearance. light / dark: [accent, text on accent, notice background].
const DEFAULT_ACCENT_THEME = 'sage';
const ACCENT_THEMES = [
  { id: 'lime', label: 'Lime', light: ['#c6f432', '#111', '#ffe9a8'], dark: ['#c6f432', '#111', '#3d3312'], covers: 'bright' },
  { id: 'sage', label: 'Sage', light: ['#b7c9a0', '#111', '#f3e4bf'], dark: ['#9fb585', '#111', '#3a3420'], covers: 'muted' },
  { id: 'olive', label: 'Olive', light: ['#a9b665', '#111', '#f3e4bf'], dark: ['#9aa85a', '#111', '#3a3420'], covers: 'earthy' },
  { id: 'ochre', label: 'Ochre', light: ['#d9b25f', '#111', '#f3e4bf'], dark: ['#c9a24f', '#111', '#3a3420'], covers: 'earthy' },
  { id: 'clay', label: 'Clay', light: ['#d4876a', '#111', '#f3dccd'], dark: ['#c4775a', '#111', '#3d2820'], covers: 'muted' },
  { id: 'teal', label: 'Teal', light: ['#7fb8ad', '#111', '#dcebe6'], dark: ['#6fa89d', '#111', '#1f3530'], covers: 'muted' },
  { id: 'slate', label: 'Slate blue', light: ['#9fb3d1', '#111', '#e1e7f0'], dark: ['#8aa0c2', '#111', '#232c3a'], covers: 'pastel' },
  { id: 'lavender', label: 'Lavender', light: ['#c3b5e0', '#111', '#ebe4f5'], dark: ['#a99bd0', '#111', '#2e2840'], covers: 'pastel' },
  { id: 'mono', label: 'Monochrome', light: ['#e2dccd', '#111', '#ece7da'], dark: ['#3d3b35', '#f1ede2', '#2a2925'], covers: 'mono' },
];
const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
const PLATFORM_CODES = { windows: 'WIN', mac: 'MAC', linux: 'LIN' };
// One-letter platform tags on the game cards; the full name is the tooltip and the screen reader text.
const PLATFORM_LETTERS = { windows: 'W', mac: 'M', linux: 'L' };
const PLATFORM_NAMES = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };
const SORT_OPTIONS = [['title', 'Title'], ['added', 'Date added'], ['size', 'Size']];
const SORT_DEFAULT_DIRECTION = { title: 'asc', added: 'desc', size: 'desc' };
const SORT_DIRECTION_WORDS = { title: ['A to Z', 'Z to A'], added: ['oldest first', 'newest first'], size: ['smallest first', 'largest first'] };
// [setting key, label, description]
const DOWNLOAD_SETTINGS = [
  ['include_hidden', 'Include hidden games', 'Syncs also get the games you hid on GOG (--include-hidden). Applies to future syncs only.'],
  ['skip_errors', 'Skip errors', 'If one game or file fails, the run continues with the next one.'],
  ['no_patches', 'Skip patches', 'Downloads do not include patch files.'],
  ['skip_existing_extras', 'Skip existing extras', 'Extras have no checksum. Without this setting, they download again every time.'],
  ['language_fallback_english', 'Fall back to English', 'If a language filter finds no files, the English files are downloaded.'],
];
const SYNC_MODES = [
  { id: 'incremental', title: 'Changed games', description: 'Gets the games that GOG marks as changed, and any owned games that are missing locally. Use this for most syncs.', command: 'update-database --updated-only' },
  { id: 'full', title: 'Full sync', description: 'Gets every game you own, one request per game. This is slow on a large library, but complete.', command: 'update-database' },
  { id: 'search', title: 'Search by title', description: 'Gets only the games whose title contains the search term. A complete library stays complete. An empty library becomes incomplete.', command: 'update-database --search=…' },
  { id: 'clear', title: 'Clear and resync', description: 'Removes all games from the local library, then does a full sync. Your login is kept.', command: 'clear, then update-database' },
];
const JOB_STATE_LABELS = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const FINISHED_STATES = ['done', 'failed', 'cancelled'];
const GOG_LOGIN_URL = 'https://auth.gog.com/auth?client_id=46899977096215655&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient&response_type=code&layout=client2';

const app = document.getElementById('app');
const main = document.getElementById('main');
const sheetSlot = document.getElementById('sheet');
const searchLabel = document.getElementById('search');
const searchInput = document.getElementById('search-input');
const syncButton = document.getElementById('sync-button');
const settingsButton = document.getElementById('settings-button');
const themeButton = document.getElementById('theme-button');
const queueEl = document.getElementById('queue');
const queuePanel = document.getElementById('queue-panel');
const queueBar = document.getElementById('queue-bar');
const toastEl = document.getElementById('toast');
const confirmSlot = document.getElementById('confirm');
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

// ---------------------------------------------------------------- helpers

class ApiError extends Error {}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options,
  });
  if (response.status === 401) {
    state.status = { authRequired: true, authenticated: false };
    render();
    throw new ApiError('Please sign in.');
  }
  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      detail = (await response.json()).detail || detail;
    } catch { /* non-JSON error body */ }
    throw new ApiError(detail);
  }
  return response.status === 204 ? null : response.json();
}

const json = (body) => ({ body: JSON.stringify(body) });

function formatSize(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

let toastTimer;
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, isError ? 6000 : 3200);
}

/** Wraps an async click handler so failures surface as a toast, not a console trace. */
function guard(handler) {
  return async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      toast(error.message || String(error), true);
    }
  };
}

function element(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  ));
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private window or blocked storage */ }
}

/**
 * An in-app confirmation dialog. Resolves true when the user accepts.
 * `label` names the action on the danger button.
 */
function confirmDialog({ title, text, label }) {
  return new Promise((resolve) => {
    const dialog = element(`
      <div class="confirm" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="confirm-box">
          <h2 id="confirm-title">${escapeHtml(title)}</h2>
          <p>${escapeHtml(text)}</p>
          <div class="btn-row">
            <button class="btn" type="button" data-answer="no">Cancel</button>
            <button class="btn danger" type="button" data-answer="yes">${escapeHtml(label)}</button>
          </div>
        </div>
      </div>
    `);
    const close = (answer) => {
      document.removeEventListener('keydown', onKey, true);
      dialog.remove();
      resolve(answer);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(false);
      }
    };
    dialog.addEventListener('click', (event) => {
      const button = event.target.closest('[data-answer]');
      if (button) close(button.dataset.answer === 'yes');
    });
    document.addEventListener('keydown', onKey, true);
    confirmSlot.replaceChildren(dialog);
    dialog.querySelector('[data-answer=no]').focus();
  });
}

/** The first letter or digit of the first two words: "Ashen Lighthouse" is AL. */
function initials(title) {
  const words = title.split(/\s+/).map((word) => word.match(/[\p{L}\p{N}]/u)?.[0]).filter(Boolean);
  return words.slice(0, 2).join('').toUpperCase();
}

/** The coloured block with initials, and the cover image on top when there is one. */
function coverHtml(game) {
  const covers = COVER_SETS[accentTheme().covers];
  const showImage = state.status.coversEnabled && !state.failedCovers.has(game.gogId);
  return `
    <div class="cover" style="background:${covers[Math.abs(game.gogId) % covers.length]}">
      <span class="cover-initials">${escapeHtml(initials(game.title))}</span>
      ${showImage ? `<img class="cover-image" src="/api/covers/${game.gogId}" alt="" loading="lazy" data-gog-id="${game.gogId}">` : ''}
    </div>`;
}

/** Games without artwork on GOG return 404: drop the image and keep the coloured block. */
function watchCoverErrors(root) {
  root.querySelectorAll('img.cover-image').forEach((image) => {
    image.addEventListener('error', () => {
      state.failedCovers.add(Number(image.dataset.gogId));
      image.remove();
    });
  });
}

/** Keeps the scroll position of `selector` inside `root` across a redraw. */
function keepScroll(root, selector, redraw) {
  const before = root.querySelector(selector)?.scrollTop || 0;
  redraw();
  const after = root.querySelector(selector);
  if (after) after.scrollTop = before;
}

// ---------------------------------------------------------------- appearance

function appearance() {
  const settings = state.settings || {};
  return {
    theme: state.settings ? settings.theme : state.localTheme,
    accent: settings.accent_theme || DEFAULT_ACCENT_THEME,
  };
}

function accentTheme() {
  const { accent } = appearance();
  return ACCENT_THEMES.find((theme) => theme.id === accent)
    || ACCENT_THEMES.find((theme) => theme.id === DEFAULT_ACCENT_THEME);
}

function isDark() {
  const { theme } = appearance();
  return theme === 'dark' || (theme !== 'light' && darkQuery.matches);
}

function applyTheme() {
  const dark = isDark();
  const [accent, onAccent, notice] = dark ? accentTheme().dark : accentTheme().light;
  app.classList.toggle('dark', dark);
  app.style.setProperty('--accent', accent);
  app.style.setProperty('--on-accent', onAccent);
  app.style.setProperty('--notice', notice);
  document.body.style.background = dark ? '#151513' : '#fffdf7';
  document.querySelector('meta[name=theme-color]').content = dark ? '#151513' : '#fffdf7';
  document.getElementById('theme-icon-sun').style.display = dark ? '' : 'none';
  document.getElementById('theme-icon-moon').style.display = dark ? 'none' : '';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  themeButton.setAttribute('aria-label', label);
  themeButton.title = label;
}

/** Saves the theme or the accent theme. Before sign-in, only this browser tab changes. */
async function saveAppearance(values) {
  if (!state.settings) {
    if (values.theme) state.localTheme = values.theme;
    render();
    return;
  }
  // Redraw first so the change shows at once, then store it.
  const before = state.settings;
  state.settings = { ...before, ...values };
  render();
  try {
    state.settings = (await api('/settings', { method: 'PUT', ...json(values) })).settings;
  } catch (error) {
    state.settings = before;
    render();
    throw error;
  }
}

// ---------------------------------------------------------------- routing

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, argument] = hash.split('/');
  return { name: name || 'library', argument };
}

function navigate(path) {
  location.hash = `#/${path}`;
}

function closeSheet() {
  navigate('library');
}

let lastHash = location.hash;
window.addEventListener('hashchange', () => {
  // Each opening of a game panel reads the game again and starts with no
  // selection, as a sync or a download may have changed it.
  if (currentRoute().name === 'game' && location.hash !== lastHash) state.detail = null;
  lastHash = location.hash;
  render();
  // Opening a panel brings fresh data with it, as the old separate screens did.
  if (currentRoute().name === 'settings') refreshSettings().then(render).catch(() => {});
});

// ---------------------------------------------------------------- data

async function refreshStatus() {
  state.status = await api('/status');
}

/** The whole library, sorted. The search filters it here, as the user types. */
let libraryRequest = 0;
async function refreshLibrary() {
  const params = new URLSearchParams({ sort: state.sortBy, direction: state.sortDirection });
  // Two quick sort clicks start two requests: only the newest may land.
  const request = ++libraryRequest;
  const { games } = await api(`/library?${params}`);
  if (request === libraryRequest) state.games = games;
}

async function refreshSettings() {
  state.settings = (await api('/settings')).settings;
}

async function refreshJobs() {
  state.jobs = (await api('/jobs')).jobs;
}

function signedIn() {
  const status = state.status;
  return Boolean(status && !(status.authRequired && !status.authenticated) && status.gogLoggedIn);
}

// Server-sent events keep the queue live without polling.
let eventSource;
function connectEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/jobs/stream');
  eventSource.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.type === 'jobs') {
      state.jobs = event.jobs;
    } else if (event.type === 'job') {
      const index = state.jobs.findIndex((job) => job.id === event.job.id);
      const wasRunning = index >= 0 && state.jobs[index].state === 'running';
      if (index >= 0) state.jobs[index] = event.job; else state.jobs.push(event.job);
      // A finished sync means the library changed underneath us, and a
      // successful one may have changed the partial-library flag.
      if (wasRunning && event.job.state !== 'running' && event.job.type === 'sync') {
        // Only the library redraws: rebuilding an open panel would lose what
        // the user is typing in it.
        Promise.all([refreshStatus(), refreshSettings(), refreshLibrary()]).then(renderLibrary).catch(() => {});
      }
    }
    renderQueue();
  };
  eventSource.onerror = () => { /* EventSource reconnects on its own */ };
}

// ---------------------------------------------------------------- render

function render() {
  app.hidden = false;
  applyTheme();
  if (!state.status) return;

  const needsUiLogin = state.status.authRequired && !state.status.authenticated;
  const inside = signedIn();
  searchLabel.hidden = !inside;
  syncButton.hidden = !inside;
  settingsButton.hidden = !inside;

  if (needsUiLogin) {
    showSignin(renderUiLogin());
  } else if (!state.status.gogLoggedIn) {
    showSignin(renderGogLogin());
  } else {
    main.className = 'library';
    renderLibrary();
  }
  renderSheet();
  renderQueue();
}

function showSignin(content) {
  main.className = 'signin';
  sheetSlot.replaceChildren();
  main.replaceChildren(content);
}

// --- UI login ---

function renderUiLogin() {
  const form = element(`
    <form class="signin-inner" autocomplete="on">
      <h1>Sign in</h1>
      <p class="signin-intro">This GOG Downloader instance is password protected.</p>
      <div class="card">
        <label class="field"><span>Username</span><input type="text" name="username" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
        <button class="btn primary block" type="submit">Sign in</button>
      </div>
    </form>
  `);
  form.addEventListener('submit', guard(async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    await api('/auth/login', { method: 'POST', ...json({
      username: data.get('username'), password: data.get('password'),
    }) });
    await boot();
  }));
  return form;
}

// --- GOG login ---

function renderGogLogin() {
  const container = element(`
    <div class="signin-inner">
      <h1>Connect your GOG account</h1>
      <p class="signin-intro">GOG Downloader reads your library from your GOG account.</p>
    </div>
  `);

  const codeCard = element(`
    <form class="card">
      <h2>Log in with a code</h2>
      <p>Open the GOG login page and sign in. GOG then shows a blank page. Copy that page's
         full address and paste it below. A code works only once and expires within minutes.</p>
      <a class="btn block" style="margin-bottom:14px" target="_blank" rel="noopener" href="${GOG_LOGIN_URL}">Open GOG login page ↗</a>
      <label class="field"><span>Code or URL</span><input type="text" name="code" autocomplete="off" required></label>
      <button class="btn primary block" type="submit">Log in</button>
    </form>
  `);
  codeCard.addEventListener('submit', guard(async (event) => {
    event.preventDefault();
    const button = codeCard.querySelector('button[type=submit]');
    button.disabled = true;
    button.textContent = 'Logging in…';
    try {
      await api('/gog/code-login', { method: 'POST', ...json({ code: new FormData(codeCard).get('code').trim() }) });
      await boot();
      toast('Logged in to GOG.');
    } finally {
      button.disabled = false;
      button.textContent = 'Log in';
    }
  }));

  const passwordCard = element(`
    <div class="card">
      <button class="disclosure" type="button" aria-expanded="${state.emailLoginOpen}">
        <span>${state.emailLoginOpen ? '−' : '+'}</span><span>Log in with email and password</span>
      </button>
      <form ${state.emailLoginOpen ? '' : 'hidden'}>
        <p style="margin:10px 0 14px">This can fail when GOG asks for a captcha or a two-factor code. The code login above is more reliable.</p>
        <label class="field"><span>Email</span><input type="email" name="email" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
        <button class="btn block" type="submit">Log in</button>
      </form>
    </div>
  `);
  passwordCard.querySelector('.disclosure').addEventListener('click', () => {
    state.emailLoginOpen = !state.emailLoginOpen;
    render();
  });
  const passwordForm = passwordCard.querySelector('form');
  passwordForm.addEventListener('submit', guard(async (event) => {
    event.preventDefault();
    const data = new FormData(passwordForm);
    await api('/gog/login', { method: 'POST', ...json({
      email: data.get('email'), password: data.get('password'),
    }) });
    await boot();
  }));

  const importCard = element(`
    <div class="card">
      <h2>Import from another install</h2>
      <p>Import a database exported from another install. It brings your login and your
         library, so you do not need to log in or sync again.</p>
      <input type="file" accept=".db,.sqlite,application/vnd.sqlite3">
      <button class="btn block" type="button">Import database…</button>
    </div>
  `);
  const input = importCard.querySelector('input');
  importCard.querySelector('button').addEventListener('click', () => input.click());
  input.addEventListener('change', guard(async () => {
    if (!input.files.length) return;
    await importDatabase(input.files[0]);
  }));

  container.append(codeCard, passwordCard, importCard);
  return container;
}

async function importDatabase(file) {
  const body = new FormData();
  body.append('file', file);
  await api('/backup/import', { method: 'POST', body });
  toast('Database imported.');
  await boot();
}

// --- library ---

function visibleGames() {
  const query = state.query.trim().toLowerCase();
  return query ? state.games.filter((game) => game.title.toLowerCase().includes(query)) : state.games;
}

function renderLibrary() {
  const container = document.createElement('div');

  if (state.settings?.sync_mode === 'search') {
    const notice = element(`
      <div class="partial-notice">
        <p><b>Your library is incomplete.</b> It holds only the results of a search sync. Run a full sync to get every game you own.</p>
        <button class="btn small" type="button">Run a full sync</button>
      </div>
    `);
    notice.querySelector('button').addEventListener('click', () => {
      state.syncMode = 'full';
      navigate('sync');
    });
    container.append(notice);
  }

  if (!state.games.length) {
    const empty = element(`
      <div class="empty-state">
        <h2>Your library is empty.</h2>
        <p>Sync with GOG to get the games you own.</p>
        <button class="btn primary" type="button">Sync library</button>
      </div>
    `);
    empty.querySelector('button').addEventListener('click', () => navigate('sync'));
    container.append(empty);
    main.replaceChildren(container);
    return;
  }

  const games = visibleGames();
  const toolbar = element(`
    <div class="library-toolbar">
      <div class="segmented" role="group" aria-label="Sort"></div>
      <span class="game-count">${games.length}/${state.games.length}</span>
    </div>
  `);
  const segmented = toolbar.querySelector('.segmented');
  for (const [key, label] of SORT_OPTIONS) {
    const active = state.sortBy === key;
    const descending = state.sortDirection === 'desc';
    const button = element(`
      <button class="${active ? 'on' : ''}" type="button"
        aria-label="${active ? `${label}, ${SORT_DIRECTION_WORDS[key][descending ? 1 : 0]}. Select to reverse the order.` : `Sort by ${label}`}">
        ${label}${active ? ` ${descending ? '↓' : '↑'}` : ''}
      </button>
    `);
    // A new sort starts in its default direction; the active one reverses.
    button.addEventListener('click', guard(async () => {
      if (active) state.sortDirection = descending ? 'asc' : 'desc';
      else {
        state.sortBy = key;
        state.sortDirection = SORT_DEFAULT_DIRECTION[key];
      }
      storageSet('librarySort', state.sortBy);
      storageSet('librarySortDirection', state.sortDirection);
      await refreshLibrary();
      renderLibrary();
    }));
    segmented.append(button);
  }
  container.append(toolbar);

  if (!games.length) {
    container.append(element(`<p style="font-size:18px">No games match “${escapeHtml(state.query)}”.</p>`));
  }

  const route = currentRoute();
  const grid = element('<div class="game-grid"></div>');
  for (const game of games) {
    const selected = route.name === 'game' && String(game.id) === String(route.argument);
    const tags = Object.keys(PLATFORM_LETTERS)
      .filter((platform) => (game.platforms || []).includes(platform))
      .map((platform) => `
        <span class="platform-tag" title="${PLATFORM_NAMES[platform]}">
          <span aria-hidden="true">${PLATFORM_LETTERS[platform]}</span><span class="visually-hidden">${PLATFORM_NAMES[platform]}</span>
        </span>`).join('');
    const card = element(`
      <button class="game-card${selected ? ' selected' : ''}" type="button">
        ${coverHtml(game)}
        <div class="game-meta">
          <b>${escapeHtml(game.title)}</b>
          <div class="game-meta-row"><span class="game-size">${formatSize(game.totalSize)}</span><span class="platform-tags">${tags}</span></div>
        </div>
      </button>
    `);
    card.addEventListener('click', () => navigate(`game/${game.id}`));
    grid.append(card);
  }
  watchCoverErrors(grid);
  container.append(grid);

  keepScroll(app, '#main', () => main.replaceChildren(container));
}

// --- panels ---

function renderSheet() {
  if (!signedIn()) {
    app.classList.remove('has-sheet', 'sheet-wide');
    return;
  }
  const route = currentRoute();
  const builders = {
    game: () => renderGameSheet(route.argument),
    sync: renderSyncSheet,
    settings: renderSettingsSheet,
  };
  const build = builders[route.name];
  app.classList.toggle('has-sheet', Boolean(build));
  app.classList.toggle('sheet-wide', route.name === 'settings');
  if (!build) {
    sheetSlot.replaceChildren();
    return;
  }
  const backdrop = element('<button class="sheet-backdrop" type="button" aria-label="Close the panel"></button>');
  backdrop.addEventListener('click', closeSheet);
  const sheet = build();
  sheet.querySelector('.sheet-head [data-close]').addEventListener('click', closeSheet);
  keepScroll(sheetSlot, '.sheet-body', () => sheetSlot.replaceChildren(backdrop, sheet));
}

function sheetFrame(heading, { wide = false, label = heading } = {}) {
  return element(`
    <section class="sheet${wide ? ' wide' : ''}" aria-label="${escapeHtml(label)}">
      <div class="sheet-head"><h2>${escapeHtml(heading)}</h2><button class="btn ghost" type="button" aria-label="Close" data-close>✕</button></div>
      <div class="sheet-body"></div>
    </section>
  `);
}

// --- game panel ---

function renderGameSheet(rowId) {
  const loaded = state.detail && String(state.detail.game.id) === String(rowId);
  const sheet = sheetFrame(loaded ? state.detail.game.title : 'Loading…', { label: 'Game' });
  const body = sheet.querySelector('.sheet-body');
  if (!loaded) {
    body.append(element('<p class="mono">Loading…</p>'));
    loadGameDetail(rowId);
    return sheet;
  }

  const { game, extras, platforms, languages } = state.detail;
  const selection = state.selection;
  const visible = visibleGroups();
  const visibleNames = visible.map((group) => group.name);

  const meta = [
    formatSize(game.totalSize),
    platforms.map((platform) => PLATFORM_CODES[platform] || platform).join(' '),
    languages.map(languageLabel).join(' '),
  ].filter(Boolean).join(' · ');
  const summary = element(`
    <div class="game-summary">
      ${coverHtml(game)}
      <div>
        <div class="mono" style="font-size:13px">${escapeHtml(meta)}</div>
        <p style="margin:6px 0 0">Select the files to download. The platform and language filters narrow the
           variants. With no filter selected, all variants are included.</p>
      </div>
    </div>
  `);
  watchCoverErrors(summary);
  body.append(summary);

  let number = 1;
  if (platforms.length > 1 || languages.length > 1) {
    const filters = element(`
      <div class="section">
        <h3><span class="section-number">${number}</span><span class="section-title">Platforms and languages</span></h3>
      </div>
    `);
    if (platforms.length > 1) filters.append(...chipRow('Platform', platforms, selection.platforms, (p) => PLATFORM_NAMES[p] || p));
    if (languages.length > 1) filters.append(...chipRow('Language', languages, selection.languages, languageLabel));
    body.append(filters);
    number += 1;
  }

  const allSelected = visible.length > 0 && visible.every((group) => selection.selected.has(group.name));
  const files = element(`
    <div class="section">
      <h3><span class="section-number">${number}</span><span class="section-title">Files</span></h3>
    </div>
  `);
  number += 1;
  if (!visible.length) {
    files.append(element('<p>No files match the selected platforms and languages.</p>'));
  } else {
    const selectAll = element(`<button class="btn small" type="button">${allSelected ? 'Clear selection' : 'Select all'}</button>`);
    selectAll.addEventListener('click', () => {
      visible.forEach((group) => {
        if (allSelected) selection.selected.delete(group.name);
        else selection.selected.add(group.name);
      });
      renderSheet();
    });
    files.querySelector('h3').append(selectAll);

    const list = element('<div class="list-box"></div>');
    visible.forEach((group, index) => {
      const variants = [...new Set(group.variants
        .map((variant) => [PLATFORM_CODES[variant.platform] || variant.platform, variant.language && languageLabel(variant.language)]
          .filter(Boolean).join(' '))
        .filter(Boolean))];
      const row = element(`
        <label class="check-row">
          <input type="checkbox" ${selection.selected.has(group.name) ? 'checked' : ''}>
          <span>
            <span class="file-name">${escapeHtml(group.name)}</span>${group.variants.some((v) => v.isPatch) ? '<span class="patch-badge">PATCH</span>' : ''}
            <small>${formatSize(group.totalSize)}${variants.length ? ` · ${escapeHtml(variants.join(', '))}` : ''}</small>
          </span>
        </label>
      `);
      // Shift-click extends from the last plainly clicked row, like a file manager.
      row.querySelector('input').addEventListener('click', (event) => {
        const checked = event.target.checked;
        const anchor = visibleNames.indexOf(selection.anchor);
        if (event.shiftKey && anchor >= 0 && anchor !== index) {
          const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
          for (let i = from; i <= to; i += 1) {
            if (checked) selection.selected.add(visibleNames[i]);
            else selection.selected.delete(visibleNames[i]);
          }
          window.getSelection()?.removeAllRanges();
        } else if (checked) selection.selected.add(group.name);
        else selection.selected.delete(group.name);
        selection.anchor = group.name;
        renderSheet();
      });
      list.append(row);
    });
    files.append(list, element('<p class="muted" style="font-size:13px;margin:8px 0 0">Shift-click to select a range of files.</p>'));
  }
  body.append(files);

  const extrasBytes = extras.reduce((sum, extra) => sum + extra.size, 0);
  if (extras.length) {
    const extrasSection = element(`
      <div class="section">
        <h3><span class="section-number">${number}</span><span class="section-title">Extras</span></h3>
        <div class="list-box">
          <label class="check-row">
            <input type="checkbox" ${selection.extras ? 'checked' : ''}>
            <span><b>Include extras · ${formatSize(extrasBytes)}</b><small>${extras.map((extra) => escapeHtml(extra.name)).join(' · ')}</small></span>
          </label>
        </div>
      </div>
    `);
    extrasSection.querySelector('input').addEventListener('change', (event) => {
      selection.extras = event.target.checked;
      renderSheet();
    });
    body.append(extrasSection);
  }

  const selectedGroups = visible.filter((group) => selection.selected.has(group.name));
  const selectedBytes = selectedGroups.reduce((sum, group) => sum + group.totalSize, 0);
  const nothing = selectedGroups.length === 0 && !selection.extras;
  const parts = [];
  if (selectedGroups.length) parts.push(plural(selectedGroups.length, 'file'));
  if (selection.extras) parts.push('extras');
  const foot = element(`
    <div class="sheet-foot">
      <span class="sheet-total">${nothing ? 'Nothing selected' : `${parts.join(' + ')} · ${formatSize(selectedBytes + (selection.extras ? extrasBytes : 0))}`}</span>
      <button class="btn primary" type="button" ${nothing ? 'disabled' : ''}>Download</button>
    </div>
  `);
  foot.querySelector('button').addEventListener('click', guard(async () => {
    await api('/jobs/download', { method: 'POST', ...json({
      game_id: game.id,
      selected: selectedGroups.map((group) => group.name),
      visible: visibleNames,
      include_extras: selection.extras,
      platforms: [...selection.platforms],
      languages: [...selection.languages],
    }) });
    state.queueOpen = true;
    toast(`Download queued: ${game.title}.`);
    closeSheet();
  }));
  sheet.append(foot);
  return sheet;
}

/** Language codes show in capitals (EN); a local name from the db shows as it is. */
function languageLabel(language) {
  return /^[a-z]{2}(_[a-z]{2})?$/.test(language) ? language.toUpperCase() : language;
}

/** Groups as they will actually download: filters applied to rows and variants. */
function visibleGroups() {
  const { groups } = state.detail;
  const { platforms, languages } = state.selection;
  return groups
    .map((group) => ({
      ...group,
      variants: group.variants.filter((variant) => (
        (platforms.size === 0 || platforms.has(variant.platform))
        && (languages.size === 0 || languages.has(variant.language))
      )),
    }))
    .map((group) => ({ ...group, totalSize: group.variants.reduce((sum, v) => sum + v.size, 0) }))
    .filter((group) => group.variants.length > 0);
}

function chipRow(label, values, selected, display) {
  const heading = element(`<div class="muted" style="font-size:14px;margin-bottom:6px">${label}</div>`);
  const chips = element('<div class="chips"></div>');
  for (const value of values) {
    const on = selected.has(value);
    const chip = element(`<button class="chip${on ? ' on' : ''}" type="button" aria-pressed="${on}">${escapeHtml(display(value))}</button>`);
    chip.addEventListener('click', () => {
      if (selected.has(value)) selected.delete(value); else selected.add(value);
      // Selected files that the new filter hides are deselected.
      const names = new Set(visibleGroups().map((group) => group.name));
      state.selection.selected = new Set([...state.selection.selected].filter((name) => names.has(name)));
      renderSheet();
    });
    chips.append(chip);
  }
  return [heading, chips];
}

let detailRequest = null; // the row id being fetched, so a redraw does not fetch it again
const loadGameDetail = guard(async (rowId) => {
  if (detailRequest === rowId) return;
  detailRequest = rowId;
  let detail;
  try {
    detail = await api(`/games/${rowId}`);
  } catch (error) {
    closeSheet();
    throw error;
  } finally {
    detailRequest = null;
  }
  // The user may have closed the panel or opened another game meanwhile.
  const route = currentRoute();
  if (route.name !== 'game' || String(route.argument) !== String(rowId)) return;
  state.detail = detail;
  state.selection = {
    selected: new Set(),
    anchor: null,
    extras: false,
    platforms: new Set(),
    languages: new Set(),
  };
  renderSheet();
  renderLibrary();
});

// --- sync panel ---

function renderSyncSheet() {
  const sheet = sheetFrame('Sync library');
  const body = sheet.querySelector('.sheet-body');
  body.append(element('<p style="margin:0 0 16px">Select a sync type. The sync is added to the queue, which runs one job at a time.</p>'));

  for (const mode of SYNC_MODES) {
    const on = state.syncMode === mode.id;
    const option = element(`
      <label class="sync-mode${on ? ' on' : ''}">
        <input type="radio" name="sync-mode" ${on ? 'checked' : ''}>
        <span><b>${mode.title}</b><small>${mode.description}</small><code>${escapeHtml(mode.command)}</code></span>
      </label>
    `);
    option.querySelector('input').addEventListener('change', () => {
      state.syncMode = mode.id;
      renderSheet();
    });
    body.append(option);
  }

  if (state.syncMode === 'search') {
    const field = element(`
      <label class="field" style="margin-top:14px"><span>Search term</span><input type="text" placeholder="e.g. Baldur" autocomplete="off"></label>
    `);
    const input = field.querySelector('input');
    input.value = state.syncSearchTerm;
    input.addEventListener('input', () => { state.syncSearchTerm = input.value; });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') startSelectedSync();
    });
    body.append(field);
  }

  const saves = element(`
    <div class="card" style="margin-top:22px">
      <h2>Cloud saves</h2>
      <p>Downloads your GOG cloud saves to <span class="mono">${escapeHtml(state.status.savesDir)}</span>.</p>
      <button class="btn" type="button">Download cloud saves</button>
    </div>
  `);
  saves.querySelector('button').addEventListener('click', guard(async () => {
    await api('/jobs/saves', { method: 'POST' });
    state.queueOpen = true;
    toast('Cloud save download queued.');
    closeSheet();
  }));
  body.append(saves);

  const selected = SYNC_MODES.find((mode) => mode.id === state.syncMode);
  const foot = element(`
    <div class="sheet-foot">
      <span class="sheet-total">${selected.title}</span>
      <button class="btn primary" type="button">Start sync</button>
    </div>
  `);
  foot.querySelector('button').addEventListener('click', startSelectedSync);
  sheet.append(foot);
  return sheet;
}

const startSelectedSync = guard(async () => {
  const mode = state.syncMode;
  const query = mode === 'search' ? state.syncSearchTerm.trim() : '';
  if (mode === 'search' && !query) {
    toast('A search sync needs a search term.', true);
    return;
  }
  if (mode === 'clear' && !await confirmDialog({
    title: 'Clear and resync?',
    text: 'All games are removed from the local library, then a full sync gets them again. Your login is kept.',
    label: 'Clear and resync',
  })) return;
  await api('/jobs/sync', { method: 'POST', ...json({ mode, query }) });
  state.queueOpen = true;
  toast('Sync queued.');
  closeSheet();
});

// --- settings panel ---

// Sections in A to Z order by title, with About last.
function renderSettingsSheet() {
  const sheet = sheetFrame('Settings', { wide: true });
  const body = sheet.querySelector('.sheet-body');
  body.append(
    appearanceSection(),
    backupSection(),
    downloadsSection(),
    cliVersionSection(),
    pathsSection(),
  );
  if (state.status.authRequired) body.append(sessionSection());
  body.append(tuningSection(), aboutSection());
  return sheet;
}

function settingsSection(title, description) {
  return element(`
    <div class="settings-section">
      <h3>${escapeHtml(title)}</h3>
      <p>${description}</p>
      <div class="settings-body"></div>
    </div>
  `);
}

const saveSettings = guard(async (values) => {
  state.settings = (await api('/settings', { method: 'PUT', ...json(values) })).settings;
  toast('Saved.');
});

function appearanceSection() {
  const section = settingsSection('Appearance',
    "Light or dark mode, and the accent colour of buttons and highlights. System follows your device's light or dark setting.");
  const slot = section.querySelector('.settings-body');
  const { theme } = appearance();
  const dark = isDark();

  const modes = element('<div class="segmented" role="group" aria-label="Mode"></div>');
  for (const [id, label] of THEMES) {
    const button = element(`<button class="${theme === id ? 'on' : ''}" type="button" aria-pressed="${theme === id}">${label}</button>`);
    button.addEventListener('click', guard(() => saveAppearance({ theme: id })));
    modes.append(button);
  }

  const accents = element('<div class="accent-options" role="group" aria-label="Accent colour"></div>');
  for (const option of ACCENT_THEMES) {
    const on = accentTheme().id === option.id;
    const button = element(`
      <button class="accent-option${on ? ' on' : ''}" type="button" aria-pressed="${on}">
        <span class="accent-swatch" style="background:${(dark ? option.dark : option.light)[0]}"></span>${option.label}
      </button>
    `);
    button.addEventListener('click', guard(() => saveAppearance({ accent_theme: option.id })));
    accents.append(button);
  }

  slot.append(modes, element('<div class="settings-label">Accent colour</div>'), accents);
  return section;
}

function backupSection() {
  const section = settingsSection('Backup',
    'The database holds your GOG login and your synced library. Export it to keep a backup or to move to another install.');
  const slot = section.querySelector('.settings-body');
  slot.classList.add('btn-row');
  slot.append(element(`<a class="btn" href="/api/backup/export" download>Export database</a>`));
  const input = element('<input type="file" accept=".db,.sqlite,application/vnd.sqlite3">');
  const button = element('<button class="btn" type="button">Import database…</button>');
  button.addEventListener('click', () => input.click());
  input.addEventListener('change', guard(async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    if (!await confirmDialog({
      title: 'Replace the database?',
      text: 'A copy of the current database is kept as gog-downloader.db.bak.',
      label: 'Replace database',
    })) return;
    await importDatabase(file);
  }));
  slot.append(input, button);
  return section;
}

function downloadsSection() {
  const section = settingsSection('Downloads', 'These settings apply to every download and sync that starts after you change them.');
  const slot = section.querySelector('.settings-body');
  slot.classList.add('list-box');
  const settings = state.settings || {};
  for (const [key, label, description] of DOWNLOAD_SETTINGS) {
    const row = element(`
      <label class="check-row">
        <input type="checkbox" ${settings[key] ? 'checked' : ''}>
        <span><b>${label}</b><small>${escapeHtml(description)}</small></span>
      </label>
    `);
    row.querySelector('input').addEventListener('change', (event) => saveSettings({ [key]: event.target.checked }));
    slot.append(row);
  }
  return section;
}

// The CLI itself is a phar downloaded into /config, so the user can move
// between upstream releases without a new container image. The release list is
// only fetched when asked for: it is a call out to GitHub.
function cliVersionSection() {
  const section = settingsSection('gog-downloader', `
    Running <span class="mono">${escapeHtml(state.status.version)}</span>. Versions you download stay in the config folder,
    so you can change back without a new download. Releases before 1.14 may not start on this container's PHP.
    If a version does not start, the current version stays in use.`);
  const slot = section.querySelector('.settings-body');
  const cli = state.cli;
  const data = cli.releases;

  if (data) {
    const options = data.releases.map((release) => {
      const labels = [];
      if (release.installed) labels.push('installed');
      if (release.prerelease) labels.push('pre-release');
      if (release.version === data.default) labels.push('image default');
      return `<option value="${escapeHtml(release.version)}">`
        + `${escapeHtml(release.version)}${labels.length ? ` — ${labels.join(', ')}` : ''}</option>`;
    }).join('');
    const picker = element(`
      <div>
        <label class="field"><span>Version</span>
          <select>${options || '<option value="">No installable releases found</option>'}</select>
        </label>
        <div class="btn-row" style="margin-bottom:12px">
          <button class="btn primary" type="button" data-action="use" ${data.releases.length ? '' : 'disabled'}>Use this version</button>
          <button class="btn danger" type="button" data-action="remove">Remove download</button>
        </div>
      </div>
    `);
    const select = picker.querySelector('select');
    if (cli.selected) select.value = cli.selected;
    const remove = picker.querySelector('[data-action=remove]');
    // Only a downloaded version that is not the image default can be removed:
    // the default is the fallback for everything else.
    const syncRemove = () => {
      cli.selected = select.value;
      const chosen = data.releases.find((release) => release.version === select.value);
      remove.disabled = !chosen || !chosen.installed || chosen.version === data.default;
    };
    select.addEventListener('change', syncRemove);
    syncRemove();

    picker.querySelector('[data-action=use]').addEventListener('click', guard(async () => {
      const version = select.value;
      if (!version || version === data.active) {
        toast(`${version} is already in use.`);
        return;
      }
      const chosen = data.releases.find((release) => release.version === version);
      if (chosen && !chosen.installed) toast(`Downloading ${version}…`);
      const result = await api('/cli/version', { method: 'PUT', ...json({ version }) });
      cli.releases = null;
      toast(`Now using ${result.version}.`);
      await boot();
    }));

    remove.addEventListener('click', guard(async () => {
      const version = select.value;
      const inUse = version === data.active;
      if (!await confirmDialog({
        title: `Remove ${version}?`,
        text: inUse
          ? `${version} is in use. After you remove it, the image default ${data.default} is used.`
          : 'The downloaded copy is removed from the config folder. You can download it again later.',
        label: `Remove ${version}`,
      })) return;
      const result = await api(`/cli/version/${encodeURIComponent(version)}`, { method: 'DELETE' });
      cli.releases = null;
      toast(`Removed ${version}. Now using ${result.version}.`);
      await boot();
    }));
    slot.append(picker);
  }

  const check = element(`<button class="btn" type="button" ${cli.checking ? 'disabled' : ''}>
    ${cli.checking ? 'Checking…' : (data ? 'Refresh list' : 'Check for versions')}</button>`);
  check.addEventListener('click', guard(async () => {
    cli.checking = true;
    renderSheet();
    try {
      cli.releases = await api(`/cli/releases${data ? '?refresh=true' : ''}`);
      cli.selected = cli.releases.active;
    } finally {
      cli.checking = false;
      renderSheet();
    }
  }));
  slot.append(check);
  return section;
}

function pathsSection() {
  const section = settingsSection('Paths', 'Set these in the container template in Unraid, not here.');
  const slot = section.querySelector('.settings-body');
  slot.classList.add('list-box');
  const status = state.status;
  const free = status.diskFree != null ? ` · ${formatSize(status.diskFree)} free` : '';
  for (const [label, path] of [[`Downloads${free}`, status.downloadDir], ['Cloud saves', status.savesDir], ['Config', status.configDir]]) {
    slot.append(element(`<div class="info-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(path)}</span></div>`));
  }
  return section;
}

function sessionSection() {
  const section = settingsSection('Session', 'Sign out of GOG Downloader in this browser.');
  const button = element('<button class="btn" type="button">Sign out</button>');
  button.addEventListener('click', guard(async () => {
    await api('/auth/logout', { method: 'POST' });
    state.queueOpen = false;
    navigate('library');
    await boot();
  }));
  section.querySelector('.settings-body').append(button);
  return section;
}

function tuningSection() {
  const section = settingsSection('Transfer tuning',
    'The defaults suit most setups. Bandwidth takes a byte count with an optional k or m suffix, for example <span class="mono">4m</span>.');
  const settings = state.settings || {};
  const form = element(`
    <form>
      <label class="field"><span>Bandwidth limit</span><input type="text" name="bandwidth" placeholder="unlimited" value="${escapeHtml(settings.bandwidth || '')}"></label>
      <label class="field"><span>Chunk size (MB, minimum 5)</span><input type="number" name="chunk_size" min="5" value="${settings.chunk_size ?? 10}"></label>
      <label class="field"><span>Retries per request</span><input type="number" name="retry" min="0" value="${settings.retry ?? 3}"></label>
      <label class="field"><span>Idle timeout (seconds)</span><input type="number" name="idle_timeout" min="1" value="${settings.idle_timeout ?? 3}"></label>
      <button class="btn primary" type="submit">Save tuning</button>
    </form>
  `);
  form.addEventListener('submit', guard(async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    await saveSettings({
      bandwidth: data.get('bandwidth').trim(),
      // Chunk size cannot be less than 5 (a CLI limit).
      chunk_size: Math.max(5, Number(data.get('chunk_size')) || 10),
      retry: Number(data.get('retry')) || 0,
      idle_timeout: Number(data.get('idle_timeout')) || 3,
    });
    renderSheet();
  }));
  section.querySelector('.settings-body').append(form);
  return section;
}

// The image's own version, as opposed to the CLI's. Commit and build date are
// only stamped in by the image build, so a checkout shows the version alone.
function aboutSection() {
  const section = settingsSection('About', 'Include these when you report a problem.');
  const status = state.status;
  const rows = [
    ['UI version', status.appVersion || 'unknown'],
    ['gog-downloader', status.version || 'unknown'],
  ];
  if (status.appCommit) rows.push(['Commit', status.appCommit.slice(0, 12)]);
  if (status.appBuildDate) rows.push(['Built', status.appBuildDate]);
  section.querySelector('.settings-body').append(
    element(`<div class="list-box" style="margin-bottom:12px">${rows.map(([label, value]) =>
      `<div class="info-row"><span>${label}</span><span>${escapeHtml(String(value))}</span></div>`).join('')}</div>`),
    element(`<a class="btn" target="_blank" rel="noreferrer"
      href="https://github.com/tangent160/docker-gogdownloader-ui/blob/main/CHANGELOG.md">Changelog ↗</a>`),
  );
  return section;
}

// --- queue ---

function renderQueue() {
  queueEl.hidden = !signedIn();
  if (queueEl.hidden) return;

  const jobs = state.jobs;
  const active = jobs.filter((job) => job.state === 'queued' || job.state === 'running').length;
  const running = jobs.find((job) => job.state === 'running');
  const determinate = Boolean(running && running.progress !== null);

  document.getElementById('queue-bar-title').textContent = running
    ? (running.type === 'sync' ? 'Syncing' : 'Downloading') : 'Queue';
  const progress = document.getElementById('queue-bar-progress');
  progress.classList.toggle('indeterminate', Boolean(running && !determinate));
  progress.firstElementChild.style.width = `${determinate ? Math.round(running.progress * 100) : 0}%`;
  let count;
  if (running) {
    count = `${determinate ? `${Math.round(running.progress * 100)}%` : '…'}${active > 1 ? ` · ${active - 1} queued` : ''}`;
  } else if (active) {
    count = `${active} queued`;
  } else {
    count = jobs.length ? `${jobs.length} finished` : 'Empty';
  }
  document.getElementById('queue-bar-count').textContent = count;
  queueBar.setAttribute('aria-expanded', String(state.queueOpen));

  queuePanel.hidden = !state.queueOpen;
  if (!state.queueOpen) return;

  const content = document.createDocumentFragment();
  const head = element('<div class="queue-head"><h3>Queue</h3></div>');
  if (jobs.some((job) => FINISHED_STATES.includes(job.state))) {
    const clear = element('<button class="btn small" type="button">Clear finished</button>');
    clear.addEventListener('click', guard(async () => {
      state.jobs = (await api('/jobs/finished', { method: 'DELETE' })).jobs;
      renderQueue();
    }));
    head.append(clear);
  }
  content.append(head);

  if (!jobs.length) {
    content.append(element('<p style="margin:0">The queue is empty. Downloads and syncs that you start show here.</p>'));
  }

  // Running first, then queued, then finished; newest first within each group.
  const order = { running: 0, queued: 1 };
  const sorted = [...jobs].reverse().sort((a, b) => (order[a.state] ?? 2) - (order[b.state] ?? 2));
  for (const job of sorted) content.append(renderJob(job));

  const scroll = queuePanel.scrollTop;
  queuePanel.replaceChildren(content);
  queuePanel.scrollTop = scroll;
}

function renderJob(job) {
  const running = job.state === 'running';
  const determinate = running && job.progress !== null;
  const outputOpen = state.logs.has(job.id);
  const line = job.error || job.lastLine || (job.state === 'queued' ? 'Waiting for the current job to finish.' : '');
  const card = element(`
    <div class="job">
      <div class="job-head"><b>${escapeHtml(job.title)}</b><span class="job-state ${job.state}">${JOB_STATE_LABELS[job.state] || escapeHtml(job.state)}</span></div>
      ${running || job.state === 'queued' ? `
        <div class="job-progress${running && !determinate ? ' indeterminate' : ''}">
          <div style="width:${determinate ? Math.round(job.progress * 100) : 0}%"></div>
        </div>` : ''}
      ${job.progressTotal ? `<div class="job-line">${job.progressCurrent} / ${job.progressTotal}</div>` : ''}
      <div class="job-line">${escapeHtml(line)}</div>
      <div class="job-actions"></div>
      ${outputOpen ? `<pre class="job-output">${escapeHtml(state.logs.get(job.id).text)}</pre>` : ''}
    </div>
  `);
  const actions = card.querySelector('.job-actions');

  if (job.state === 'queued' || running) {
    const cancel = element('<button class="btn small danger" type="button">Cancel</button>');
    cancel.addEventListener('click', guard(async () => {
      await api(`/jobs/${job.id}/cancel`, { method: 'POST' });
    }));
    actions.append(cancel);
  }

  const toggle = element(`<button class="btn small ghost" type="button">${outputOpen ? 'Hide output' : 'Show output'}</button>`);
  toggle.addEventListener('click', () => {
    if (outputOpen) state.logs.delete(job.id);
    else {
      state.logs.set(job.id, { text: 'Loading…', fetchedAt: 0 });
      loadLog(job.id);
    }
    renderQueue();
  });
  actions.append(toggle);

  // A running job's output grows: re-read it at most once a second.
  if (outputOpen && running && Date.now() - state.logs.get(job.id).fetchedAt > 1000) loadLog(job.id);
  return card;
}

const loadLog = guard(async (jobId) => {
  const entry = state.logs.get(jobId);
  if (!entry) return;
  entry.fetchedAt = Date.now();
  const { log } = await api(`/jobs/${jobId}/log`);
  if (!state.logs.has(jobId)) return;
  state.logs.set(jobId, { text: log.join('\n') || '(no output yet)', fetchedAt: entry.fetchedAt });
  renderQueue();
});

// ---------------------------------------------------------------- chrome events

syncButton.addEventListener('click', () => navigate('sync'));
settingsButton.addEventListener('click', () => navigate('settings'));
themeButton.addEventListener('click', guard(() => saveAppearance({ theme: isDark() ? 'light' : 'dark' })));
queueBar.addEventListener('click', () => {
  state.queueOpen = !state.queueOpen;
  renderQueue();
});

// The "System" theme follows the device setting, live.
darkQuery.addEventListener('change', () => render());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && signedIn() && ['game', 'sync', 'settings'].includes(currentRoute().name)) closeSheet();
});

searchInput.addEventListener('input', () => {
  state.query = searchInput.value;
  renderLibrary();
});

// ---------------------------------------------------------------- boot

function restoreSort() {
  let sortBy = storageGet('librarySort');
  if (sortBy === 'recent') sortBy = 'added'; // the name before 0.2.0
  if (!SORT_DEFAULT_DIRECTION[sortBy]) sortBy = 'title';
  const direction = storageGet('librarySortDirection');
  state.sortBy = sortBy;
  state.sortDirection = direction === 'asc' || direction === 'desc' ? direction : SORT_DEFAULT_DIRECTION[sortBy];
}

async function boot() {
  await refreshStatus();
  if (state.status.authRequired && !state.status.authenticated) {
    state.settings = null;
    render();
    return;
  }
  await Promise.all([refreshSettings(), refreshJobs()]);
  if (state.status.gogLoggedIn) await refreshLibrary();
  connectEvents();
  render();
}

restoreSort();
boot().catch((error) => {
  main.className = 'signin';
  main.replaceChildren(element(`<div class="empty-state"><h2>Could not reach the server.</h2><p>${escapeHtml(error.message)}</p></div>`));
  applyTheme();
  app.hidden = false;
});
