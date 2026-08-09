// Single-page UI. No build step and no framework: the whole app is a small
// state object, a hash router and a handful of render functions.

const state = {
  status: null,
  games: [],
  query: '',
  sort: localStorage.getItem('librarySort') || 'title',
  jobs: [],
  settings: null,
  detail: null,       // { game, groups, extras, platforms, languages }
  selection: null,    // { selected:Set, extras:bool, platforms:Set, languages:Set }
  openLogs: new Set(),
};

const app = document.getElementById('app');
const main = document.getElementById('main');
const title = document.getElementById('screen-title');
const backButton = document.getElementById('back-button');
const searchToggle = document.getElementById('search-toggle');
const searchbar = document.getElementById('searchbar');
const searchInput = document.getElementById('search-input');
const tabbar = document.getElementById('tabbar');
const queueBadge = document.getElementById('queue-badge');
const toastEl = document.getElementById('toast');

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
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

let toastTimer;
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, isError ? 6000 : 3000);
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

// ---------------------------------------------------------------- routing

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, argument] = hash.split('/');
  return { name: name || 'library', argument };
}

function navigate(path) {
  location.hash = `#/${path}`;
}

window.addEventListener('hashchange', () => { render(); });

// ---------------------------------------------------------------- data

async function refreshStatus() {
  state.status = await api('/status');
}

async function refreshLibrary() {
  const params = new URLSearchParams({ q: state.query, sort: state.sort });
  state.games = (await api(`/library?${params}`)).games;
}

async function refreshSettings() {
  state.settings = (await api('/settings')).settings;
}

async function refreshJobs() {
  state.jobs = (await api('/jobs')).jobs;
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
      // A finished sync means the library changed underneath us.
      if (wasRunning && event.job.state !== 'running' && event.job.type === 'sync') {
        refreshStatus().then(render).catch(() => {});
        if (currentRoute().name === 'library') refreshLibrary().then(render).catch(() => {});
      }
    }
    updateQueueBadge();
    if (currentRoute().name === 'queue') renderQueue();
  };
  eventSource.onerror = () => { /* EventSource reconnects on its own */ };
}

function updateQueueBadge() {
  const active = state.jobs.filter((job) => job.state === 'queued' || job.state === 'running').length;
  queueBadge.hidden = active === 0;
  queueBadge.textContent = String(active);
}

// ---------------------------------------------------------------- screens

function render() {
  app.hidden = false;
  const route = currentRoute();

  if (!state.status) return;
  if (state.status.authRequired && !state.status.authenticated) return renderChrome('Sign in', renderUiLogin());
  if (!state.status.gogLoggedIn) return renderChrome('Connect to GOG', renderGogLogin());

  const screens = {
    library: () => renderChrome('Library', renderLibrary(), { search: true }),
    game: () => renderChrome(gameHeading(route.argument), renderGameDetail(route.argument), { back: true }),
    queue: () => renderChrome('Queue', renderQueueScreen()),
    settings: () => renderChrome('Settings', renderSettings()),
    sync: () => renderChrome('Sync library', renderSyncScreen(), { back: true }),
  };
  (screens[route.name] || screens.library)();
  updateQueueBadge();
}

function renderChrome(heading, content, options = {}) {
  title.textContent = heading;
  backButton.hidden = !options.back;
  searchToggle.hidden = !options.search;
  if (!options.search) closeSearch();
  tabbar.hidden = Boolean(options.back) && innerWidthIsNarrow();
  main.replaceChildren(content);
  const route = currentRoute().name;
  tabbar.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.route === route || (route === 'game' && tab.dataset.route === 'library');
    tab.setAttribute('aria-current', active ? 'page' : 'false');
  });
}

function gameHeading(rowId) {
  const loaded = state.detail && String(state.detail.game.id) === String(rowId);
  return loaded ? state.detail.game.title : 'Loading…';
}

function innerWidthIsNarrow() {
  return false; // the tab bar stays visible; kept as one place to change that
}

// --- UI login ---

function renderUiLogin() {
  const form = element(`
    <form class="card" autocomplete="on">
      <h2>Sign in</h2>
      <p>This GOG Downloader instance is password protected.</p>
      <label class="field"><span>Username</span><input type="text" name="username" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
      <button class="button" type="submit">Sign in</button>
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
  const container = document.createElement('div');

  const codeCard = element(`
    <form class="card">
      <h2>Log in with a code</h2>
      <p>Open GOG's login page, sign in, and you will land on a blank page.
         Copy that page's full address and paste it below. Codes are single-use
         and expire within minutes.</p>
      <a class="button secondary" style="text-decoration:none" target="_blank" rel="noopener"
         href="https://auth.gog.com/auth?client_id=46899977096215655&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient&response_type=code&layout=client2">Open GOG login page</a>
      <div class="spacer"></div>
      <label class="field"><span>Code or URL</span><input type="text" name="code" autocomplete="off" required></label>
      <button class="button" type="submit">Log in</button>
    </form>
  `);
  codeCard.addEventListener('submit', guard(async (event) => {
    event.preventDefault();
    const button = codeCard.querySelector('button[type=submit]');
    button.disabled = true;
    button.textContent = 'Logging in…';
    try {
      await api('/gog/code-login', { method: 'POST', ...json({ code: new FormData(codeCard).get('code') }) });
      await boot();
      toast('Logged in to GOG.');
    } finally {
      button.disabled = false;
      button.textContent = 'Log in';
    }
  }));

  const passwordCard = element(`
    <details class="card">
      <summary>Log in with email and password</summary>
      <p class="muted" style="margin-top:12px">May fail when GOG asks for a captcha or two-factor code — the code login above is more reliable.</p>
      <form>
        <label class="field"><span>Email</span><input type="email" name="email" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
        <button class="button secondary" type="submit">Log in</button>
      </form>
    </details>
  `);
  passwordCard.querySelector('form').addEventListener('submit', guard(async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    await api('/gog/login', { method: 'POST', ...json({
      email: data.get('email'), password: data.get('password'),
    }) });
    await boot();
  }));

  container.append(codeCard, passwordCard, restoreBackupCard());
  return container;
}

function restoreBackupCard() {
  const card = element(`
    <div class="card">
      <h2>Restore a backup</h2>
      <p>Import a database exported from another install to bring your login and library with you instead of logging in again.</p>
      <input type="file" id="import-file" accept=".db,.sqlite,application/vnd.sqlite3" hidden>
      <button class="button secondary" type="button">Import database…</button>
    </div>
  `);
  const input = card.querySelector('input');
  card.querySelector('button').addEventListener('click', () => input.click());
  input.addEventListener('change', guard(async () => {
    if (!input.files.length) return;
    const body = new FormData();
    body.append('file', input.files[0]);
    await api('/backup/import', { method: 'POST', body });
    toast('Database imported.');
    await boot();
  }));
  return card;
}

// --- library ---

function renderLibrary() {
  const container = document.createElement('div');

  if (!state.games.length && !state.query) {
    const empty = element(`
      <div class="empty">
        <h2>Your library is empty</h2>
        <p>Sync with GOG to fetch the games you own.</p>
        <button class="button" type="button">Sync now</button>
      </div>
    `);
    empty.querySelector('button').addEventListener('click', () => navigate('sync'));
    container.append(empty);
    return container;
  }

  const toolbar = element(`
    <div class="library-toolbar">
      <select aria-label="Sort library">
        <option value="title">Title</option>
        <option value="recent">Recently added</option>
        <option value="size">Total size</option>
      </select>
      <button class="button secondary" type="button" style="width:auto;min-width:0;min-height:40px">Sync</button>
      <span class="count">${state.games.length} game${state.games.length === 1 ? '' : 's'}</span>
    </div>
  `);
  const select = toolbar.querySelector('select');
  select.value = state.sort;
  select.addEventListener('change', guard(async () => {
    state.sort = select.value;
    localStorage.setItem('librarySort', state.sort);
    await refreshLibrary();
    render();
  }));
  toolbar.querySelector('button').addEventListener('click', () => navigate('sync'));
  container.append(toolbar);

  if (!state.games.length) {
    container.append(element(`<p class="empty">No games match “${escapeHtml(state.query)}”.</p>`));
    return container;
  }

  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const game of state.games) {
    const card = element(`
      <button class="game-card" type="button">
        ${state.status.coversEnabled
          ? `<img class="cover" loading="lazy" alt="" src="/api/covers/${game.gogId}">`
          : `<div class="cover cover-fallback">${escapeHtml(game.title)}</div>`}
        <div class="meta">
          <div class="title">${escapeHtml(game.title)}</div>
          <div class="size">${formatSize(game.totalSize)}</div>
        </div>
      </button>
    `);
    const image = card.querySelector('img');
    if (image) {
      // Games without artwork on GOG return 404 — fall back to the title.
      image.addEventListener('error', () => {
        const fallback = element(`<div class="cover cover-fallback">${escapeHtml(game.title)}</div>`);
        image.replaceWith(fallback);
      });
    }
    card.addEventListener('click', () => navigate(`game/${game.id}`));
    grid.append(card);
  }
  container.append(grid);
  return container;
}

// --- game detail ---

function renderGameDetail(rowId) {
  const container = document.createElement('div');
  if (!state.detail || String(state.detail.game.id) !== String(rowId)) {
    container.append(element('<p class="muted">Loading…</p>'));
    loadGameDetail(rowId);
    return container;
  }

  const { game, groups, extras, platforms, languages } = state.detail;
  const selection = state.selection;
  const visible = visibleGroups();

  if (platforms.length > 1 || languages.length > 1) {
    const filters = element(`
      <div class="card">
        <h2>Filters</h2>
        <p>GOG reuses one installer name across platform and language variants.
           Narrow the variants you want here — the filters are passed to the download itself.</p>
      </div>
    `);
    if (platforms.length > 1) filters.append(chipRow('Platform', platforms, selection.platforms));
    if (languages.length > 1) filters.append(chipRow('Language', languages, selection.languages));
    container.append(filters);
  }

  const installers = element(`
    <div class="card">
      <h2>Installers and patches</h2>
      <p>${visible.length} available · ${formatSize(visible.reduce((sum, group) => sum + group.totalSize, 0))}</p>
    </div>
  `);
  if (!visible.length) {
    installers.append(element('<p class="muted">No files match the current filters.</p>'));
  } else {
    const selectAll = element(`
      <button class="button secondary" type="button">
        ${visible.every((group) => selection.selected.has(group.name)) ? 'Clear selection' : 'Select all'}
      </button>
    `);
    selectAll.addEventListener('click', () => {
      const all = visible.every((group) => selection.selected.has(group.name));
      visible.forEach((group) => {
        if (all) selection.selected.delete(group.name);
        else selection.selected.add(group.name);
      });
      render();
    });
    installers.append(selectAll, element('<div class="spacer"></div>'));

    for (const group of visible) {
      const variants = group.variants
        .map((variant) => [variant.platform, variant.language].filter(Boolean).join(' · '))
        .filter(Boolean);
      const row = element(`
        <label class="file-row">
          <input type="checkbox" ${selection.selected.has(group.name) ? 'checked' : ''}>
          <span>
            <span class="name">${escapeHtml(group.name)}${group.variants.some((v) => v.isPatch) ? ' <em class="muted">(patch)</em>' : ''}</span>
            <span class="variants">${formatSize(group.totalSize)}${variants.length ? ` · ${escapeHtml([...new Set(variants)].join(', '))}` : ''}</span>
          </span>
        </label>
      `);
      row.querySelector('input').addEventListener('change', (event) => {
        if (event.target.checked) selection.selected.add(group.name);
        else selection.selected.delete(group.name);
      });
      installers.append(row);
    }
  }
  container.append(installers);

  if (extras.length) {
    const extrasCard = element(`
      <div class="card">
        <h2>Extras</h2>
        <p>${extras.length} file${extras.length === 1 ? '' : 's'} · ${formatSize(extras.reduce((sum, extra) => sum + extra.size, 0))}</p>
        <label class="switch">
          <span>Include extras<small>Soundtracks, manuals and artwork. Downloaded as a separate pass.</small></span>
          <input type="checkbox" ${selection.extras ? 'checked' : ''}>
        </label>
        <div class="muted">${extras.slice(0, 12).map((extra) => escapeHtml(extra.name)).join(' · ')}${extras.length > 12 ? ' …' : ''}</div>
      </div>
    `);
    extrasCard.querySelector('input').addEventListener('change', (event) => {
      selection.extras = event.target.checked;
      render();
    });
    container.append(extrasCard);
  }

  const action = element(`
    <div class="sticky-action">
      <button class="button" type="button" style="width:100%">Download</button>
    </div>
  `);
  const button = action.querySelector('button');
  const selectedCount = selection.selected.size;
  const selectedBytes = visible
    .filter((group) => selection.selected.has(group.name))
    .reduce((sum, group) => sum + group.totalSize, 0);
  button.disabled = selectedCount === 0 && !selection.extras;
  button.textContent = button.disabled
    ? 'Select something to download'
    : `Download ${selectedCount ? `${selectedCount} file${selectedCount === 1 ? '' : 's'} (${formatSize(selectedBytes)})` : 'extras'}`;
  button.addEventListener('click', guard(async () => {
    await api('/jobs/download', { method: 'POST', ...json({
      game_id: game.id,
      selected: [...selection.selected],
      visible: visible.map((group) => group.name),
      include_extras: selection.extras,
      platforms: [...selection.platforms],
      languages: [...selection.languages],
    }) });
    toast(`Queued ${game.title}.`);
    navigate('queue');
  }));
  container.append(action);

  return container;
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

function chipRow(label, values, selected) {
  const row = element(`<div><div class="muted" style="margin-bottom:6px">${label}</div><div class="chips"></div></div>`);
  const chips = row.querySelector('.chips');
  for (const value of values) {
    const chip = element(`<button class="chip" type="button" aria-pressed="${selected.has(value)}">${escapeHtml(value)}</button>`);
    chip.addEventListener('click', () => {
      if (selected.has(value)) selected.delete(value); else selected.add(value);
      // Selections whose group vanished under the new filters must go too.
      const names = new Set(visibleGroups().map((group) => group.name));
      state.selection.selected = new Set([...state.selection.selected].filter((name) => names.has(name)));
      render();
    });
    chips.append(chip);
  }
  return row;
}

const loadGameDetail = guard(async (rowId) => {
  const detail = await api(`/games/${rowId}`);
  state.detail = detail;
  state.selection = {
    selected: new Set(),
    extras: false,
    platforms: new Set(),
    languages: new Set(),
  };
  render();
});

// --- sync ---

function renderSyncScreen() {
  const container = document.createElement('div');
  const partial = state.settings?.sync_mode === 'search';

  if (partial) {
    container.append(element(`
      <div class="card">
        <h2>Partial library</h2>
        <p>Your library was last populated with a search, so it holds only the
           matching games. Run a full sync to fetch everything you own.</p>
      </div>
    `));
  }

  const modes = [
    ['incremental', 'Update changed games', 'Fetches games that changed, plus anything you own that is missing locally. The usual choice.'],
    ['full', 'Full sync', 'One API request per owned game. Slow on a large library, but the most complete.'],
    ['search', 'Sync matching games only', 'Fetches just the games matching a search term — useful for a first look without a full sync.'],
    ['clear', 'Clear and resync', 'Empties the local library first, then does a full sync. Your login is kept.'],
  ];

  for (const [mode, heading, description] of modes) {
    const card = element(`
      <form class="card">
        <h2>${heading}</h2>
        <p>${description}</p>
        ${mode === 'search' ? '<label class="field"><span>Search term</span><input type="text" name="query" required></label>' : ''}
        <button class="button ${mode === 'incremental' ? '' : 'secondary'}" type="submit">Start</button>
      </form>
    `);
    card.addEventListener('submit', guard(async (event) => {
      event.preventDefault();
      const query = new FormData(card).get('query') || '';
      await api('/jobs/sync', { method: 'POST', ...json({ mode, query }) });
      await refreshSettings();
      toast('Sync queued.');
      navigate('queue');
    }));
    container.append(card);
  }

  const savesCard = element(`
    <div class="card">
      <h2>Cloud saves</h2>
      <p>Downloads your GOG cloud saves to <code>${escapeHtml(state.status.savesDir)}</code>.</p>
      <button class="button secondary" type="button">Download cloud saves</button>
    </div>
  `);
  savesCard.querySelector('button').addEventListener('click', guard(async () => {
    await api('/jobs/saves', { method: 'POST' });
    toast('Cloud save download queued.');
    navigate('queue');
  }));
  container.append(savesCard);

  return container;
}

// --- queue ---

function renderQueueScreen() {
  const container = document.createElement('div');
  container.id = 'queue-root';
  renderQueueInto(container);
  return container;
}

function renderQueue() {
  const container = document.getElementById('queue-root');
  if (container) renderQueueInto(container);
  updateQueueBadge();
}

function renderQueueInto(container) {
  container.replaceChildren();

  if (!state.jobs.length) {
    container.append(element(`
      <div class="empty">
        <h2>Nothing queued</h2>
        <p>Downloads and syncs you start will show up here.</p>
      </div>
    `));
    return;
  }

  const finished = state.jobs.filter((job) => ['done', 'failed', 'cancelled'].includes(job.state));
  if (finished.length) {
    const clear = element('<button class="button secondary" type="button">Clear finished</button>');
    clear.addEventListener('click', guard(async () => {
      state.jobs = (await api('/jobs/finished', { method: 'DELETE' })).jobs;
      renderQueue();
    }));
    container.append(clear, element('<div class="spacer"></div>'));
  }

  // Newest first: an active download is what the user came to look at.
  for (const job of [...state.jobs].reverse()) {
    container.append(renderJob(job));
  }
}

function renderJob(job) {
  const running = job.state === 'running';
  const showProgress = running || job.state === 'queued';
  const card = element(`
    <div class="job">
      <div class="job-head">
        <span class="title">${escapeHtml(job.title)}</span>
        <span class="state ${job.state}">${job.state}</span>
      </div>
      ${showProgress ? `
        <div class="progress ${running && job.progress === null ? 'indeterminate' : ''}">
          <div style="width:${running ? Math.round((job.progress || 0) * 100) : 0}%"></div>
        </div>` : ''}
      ${job.progressTotal ? `<div class="line">${job.progressCurrent} / ${job.progressTotal}</div>` : ''}
      <div class="line">${escapeHtml(job.error || job.lastLine || (job.state === 'queued' ? 'Waiting for the current job to finish…' : ''))}</div>
    </div>
  `);

  if (job.state === 'queued' || running) {
    const cancel = element('<button class="button danger" type="button" style="margin-top:10px">Cancel</button>');
    cancel.addEventListener('click', guard(async () => {
      await api(`/jobs/${job.id}/cancel`, { method: 'POST' });
    }));
    card.append(cancel);
  }

  const details = element('<details><summary class="muted">Output</summary><pre>Loading…</pre></details>');
  details.open = state.openLogs.has(job.id);
  const loadLog = guard(async () => {
    const { log } = await api(`/jobs/${job.id}/log`);
    details.querySelector('pre').textContent = log.join('\n') || '(no output yet)';
  });
  details.addEventListener('toggle', () => {
    if (details.open) { state.openLogs.add(job.id); loadLog(); } else state.openLogs.delete(job.id);
  });
  if (details.open) loadLog();
  card.append(details);

  return card;
}

// --- settings ---

// The CLI itself is a phar downloaded into /config, so the user can move
// between upstream releases without a new container image. The release list is
// only fetched when asked for: it is a call out to GitHub.
function renderCliVersionCard() {
  const card = element(`
    <div class="card">
      <h2>gog-downloader</h2>
      <p>Running version <strong>${escapeHtml(state.status.version)}</strong>.
         Versions you install are kept in the config folder, so switching back is instant.
         Older releases may not start on this container's PHP — if one is rejected, the
         current version keeps running.</p>
      <div class="cli-versions"></div>
      <button class="button secondary" type="button">Check for versions</button>
    </div>
  `);
  const slot = card.querySelector('.cli-versions');
  const check = card.querySelector('button');

  const paint = (data) => {
    const options = data.releases.map((release) => {
      const labels = [];
      if (release.installed) labels.push('installed');
      if (release.prerelease) labels.push('pre-release');
      if (release.version === data.default) labels.push('image default');
      return `<option value="${escapeHtml(release.version)}" ${release.active ? 'selected' : ''}>`
        + `${escapeHtml(release.version)}${labels.length ? ` — ${labels.join(', ')}` : ''}</option>`;
    }).join('');

    slot.replaceChildren(element(`
      <div>
        <label class="field"><span>Version</span>
          <select>${options || '<option value="">No installable releases found</option>'}</select>
        </label>
        <div class="row">
          <button class="button" type="button" data-action="use" ${data.releases.length ? '' : 'disabled'}>Use this version</button>
          <button class="button secondary" type="button" data-action="remove">Remove download</button>
        </div>
      </div>
    `));

    const select = slot.querySelector('select');
    const remove = slot.querySelector('[data-action=remove]');

    // Only a downloaded, non-default version can be deleted: the default is
    // the fallback for everything else.
    const syncRemove = () => {
      const chosen = data.releases.find((release) => release.version === select.value);
      remove.disabled = !chosen || !chosen.installed || chosen.version === data.default;
    };
    select.addEventListener('change', syncRemove);
    syncRemove();

    slot.querySelector('[data-action=use]').addEventListener('click', guard(async () => {
      const version = select.value;
      if (!version || version === data.active) {
        toast('That version is already in use.');
        return;
      }
      const chosen = data.releases.find((release) => release.version === version);
      if (chosen && !chosen.installed) toast(`Downloading ${version}…`);
      const result = await api('/cli/version', { method: 'PUT', ...json({ version }) });
      toast(`Now running ${result.version}.`);
      await boot();
    }));

    remove.addEventListener('click', guard(async () => {
      const version = select.value;
      const inUse = version === data.active;
      const question = inUse
        ? `Remove ${version}? It is in use, so the container will fall back to ${data.default}.`
        : `Remove the downloaded copy of ${version}?`;
      if (!confirm(question)) return;
      const result = await api(`/cli/version/${encodeURIComponent(version)}`, { method: 'DELETE' });
      toast(`Removed ${version}. Running ${result.version}.`);
      await boot();
    }));
  };

  check.addEventListener('click', guard(async () => {
    check.disabled = true;
    check.textContent = 'Checking…';
    try {
      paint(await api('/cli/releases'));
      check.textContent = 'Refresh list';
    } finally {
      check.disabled = false;
    }
  }));

  return card;
}

function renderSettings() {
  const container = document.createElement('div');
  const settings = state.settings || {};

  const save = guard(async (values) => {
    state.settings = (await api('/settings', { method: 'PUT', ...json(values) })).settings;
    toast('Saved.');
  });

  const paths = element(`
    <div class="card">
      <h2>Paths</h2>
      <p>Set these on the container in the Unraid template, not here.</p>
      <div class="switch"><span>Downloads<small>${escapeHtml(state.status.downloadDir)}</small></span>
        <span class="muted">${state.status.diskFree != null ? `${formatSize(state.status.diskFree)} free` : ''}</span></div>
      <div class="switch"><span>Cloud saves<small>${escapeHtml(state.status.savesDir)}</small></span></div>
      <div class="switch"><span>Config<small>${escapeHtml(state.status.configDir)}</small></span></div>
    </div>
  `);
  container.append(paths);
  container.append(renderCliVersionCard());

  const toggles = [
    ['include_hidden', 'Include hidden games', 'Adds --include-hidden to every sync so games you hid on GOG are fetched too. Only affects future syncs.'],
    ['skip_errors', 'Skip errors', 'Keep going when a single game or file fails instead of aborting the whole run.'],
    ['no_patches', 'Skip patches', 'Leave patch files out of downloads.'],
    ['skip_existing_extras', 'Skip existing extras', 'Extras have no hash to verify, so without this they are re-downloaded every time.'],
    ['language_fallback_english', 'Fall back to English', 'When a language filter finds nothing, download the English version instead.'],
  ];
  const behaviour = element('<div class="card"><h2>Downloads</h2></div>');
  for (const [key, label, description] of toggles) {
    const row = element(`
      <label class="switch">
        <span>${label}<small>${description}</small></span>
        <input type="checkbox" ${settings[key] ? 'checked' : ''}>
      </label>
    `);
    row.querySelector('input').addEventListener('change', (event) => save({ [key]: event.target.checked }));
    behaviour.append(row);
  }
  container.append(behaviour);

  const tuning = element(`
    <form class="card">
      <h2>Transfer tuning</h2>
      <p>Defaults suit most setups. Bandwidth accepts a byte count with an optional k or m suffix, for example <code>4m</code>.</p>
      <label class="field"><span>Bandwidth limit</span><input type="text" name="bandwidth" placeholder="unlimited" value="${escapeHtml(settings.bandwidth || '')}"></label>
      <label class="field"><span>Chunk size (MB, minimum 5)</span><input type="number" name="chunk_size" min="5" value="${settings.chunk_size ?? 10}"></label>
      <label class="field"><span>Retries per request</span><input type="number" name="retry" min="0" value="${settings.retry ?? 3}"></label>
      <label class="field"><span>Idle timeout (seconds)</span><input type="number" name="idle_timeout" min="1" value="${settings.idle_timeout ?? 3}"></label>
      <button class="button" type="submit">Save</button>
    </form>
  `);
  tuning.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(tuning);
    save({
      bandwidth: data.get('bandwidth').trim(),
      chunk_size: Math.max(5, Number(data.get('chunk_size')) || 10),
      retry: Number(data.get('retry')) || 0,
      idle_timeout: Number(data.get('idle_timeout')) || 3,
    });
  });
  container.append(tuning);

  const backup = element(`
    <div class="card">
      <h2>Backup</h2>
      <p>The database holds your GOG login and your whole synced library — export it
         to move to another install or to recover without syncing again.</p>
      <a class="button secondary" style="text-decoration:none" href="/api/backup/export" download>Export database</a>
      <input type="file" id="settings-import" accept=".db,.sqlite,application/vnd.sqlite3" hidden>
      <button class="button secondary" type="button">Import database…</button>
    </div>
  `);
  const importInput = backup.querySelector('input[type=file]');
  backup.querySelector('button').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', guard(async () => {
    if (!importInput.files.length) return;
    if (!confirm('Replace the current database? A copy of the current one is kept as gog-downloader.db.bak.')) {
      importInput.value = '';
      return;
    }
    const body = new FormData();
    body.append('file', importInput.files[0]);
    await api('/backup/import', { method: 'POST', body });
    toast('Database imported.');
    await boot();
  }));
  container.append(backup);

  if (state.status.authRequired) {
    const account = element(`
      <div class="card">
        <h2>Session</h2>
        <button class="button secondary" type="button">Sign out</button>
      </div>
    `);
    account.querySelector('button').addEventListener('click', guard(async () => {
      await api('/auth/logout', { method: 'POST' });
      await boot();
    }));
    container.append(account);
  }

  return container;
}

// ---------------------------------------------------------------- chrome events

backButton.addEventListener('click', () => history.back());

tabbar.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) navigate(tab.dataset.route);
});

searchToggle.addEventListener('click', () => {
  searchbar.hidden = false;
  searchInput.focus();
});

document.getElementById('search-close').addEventListener('click', guard(async () => {
  closeSearch();
  if (state.query) {
    state.query = '';
    await refreshLibrary();
    render();
  }
}));

function closeSearch() {
  searchbar.hidden = true;
}

let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(guard(async () => {
    state.query = searchInput.value;
    await refreshLibrary();
    render();
  }), 200);
});

searchbar.addEventListener('submit', (event) => event.preventDefault());

// ---------------------------------------------------------------- boot

async function boot() {
  await refreshStatus();
  if (state.status.authRequired && !state.status.authenticated) {
    render();
    return;
  }
  await Promise.all([refreshSettings(), refreshJobs()]);
  if (state.status.gogLoggedIn) await refreshLibrary();
  connectEvents();
  render();
}

boot().catch((error) => {
  main.replaceChildren(element(`<div class="empty"><h2>Could not reach the server</h2><p>${escapeHtml(error.message)}</p></div>`));
  app.hidden = false;
});
