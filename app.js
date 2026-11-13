/* Haze Tracker UI. Shared logic lives in lib.js (global `Haze`). */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const REFRESH_MS = 5 * 60 * 1000;
  const STALE_MS = 3 * 60 * 60 * 1000;
  const CACHE_KEY = 'haze:last';

  const store = 'indexedDB' in window ? Haze.idbStore : Haze.createMemoryStore();
  let settings = Object.assign({}, Haze.DEFAULT_SETTINGS);
  let data = { psi: null, pm25: null, fetchedAt: 0 };
  let background = 'unknown'; // 'on' | 'off' | 'unknown'
  let installPrompt = null;
  let inflight = null;

  // ---- small helpers -------------------------------------------------------

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  const isIos = () =>
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const fmtMs = (ms) => Haze.formatTime(new Date(ms).toISOString());

  function setStatus(msg, isError) {
    const s = $('alert-status');
    s.textContent = msg || '';
    s.classList.toggle('error', !!isError);
  }

  // ---- rendering -----------------------------------------------------------

  function card(region, wide) {
    const v = data.psi && data.psi.values[region];
    const p = data.pm25 && data.pm25.values[region];
    const b = Haze.psiBand(v);
    const pb = Haze.pm25Band(p);
    const watched = settings.enabled && settings.region === region;

    const c = el('article', 'rc' + (wide ? ' wide' : ''));
    c.dataset.region = region;
    if (b) c.dataset.tone = b.tone;
    c.dataset.watched = String(watched);
    c.dataset.over = String(watched && typeof v === 'number' && v >= settings.threshold);

    c.append(el('h3', '', Haze.regionLabel(region)));

    const main = el('div', 'main');
    main.append(el('div', 'psi', typeof v === 'number' ? String(v) : '–'));
    main.append(el('span', 'unit', '24-hr PSI'));
    main.append(el('span', 'pill', b ? b.label : 'No data'));
    c.append(main);

    const pm = el('div', 'pm');
    pm.append(el('strong', '', typeof p === 'number' ? String(p) : '–'));
    pm.append(el('span', 'unit', '1-hr PM2.5 µg/m³'));
    const pill = el('span', 'pill', pb ? pb.label : 'No data');
    if (pb) pill.dataset.tone = pb.tone;
    pm.append(pill);
    c.append(pm);

    if (watched) {
      c.append(el('span', 'flag', c.dataset.over === 'true' ? 'At or above alert level' : 'Alert region'));
    }
    return c;
  }

  function renderRegions() {
    const regions = $('regions');
    regions.replaceChildren(...Haze.REGIONS.map((r) => card(r, false)));

    const hasNational =
      (data.psi && 'national' in data.psi.values) || (data.pm25 && 'national' in data.pm25.values);
    $('national').replaceChildren(...(hasNational ? [card('national', true)] : []));
  }

  function renderUpdated() {
    const u = $('updated');
    if (!data.psi && !data.pm25) { u.textContent = 'No readings yet'; return; }
    const parts = [];
    if (data.psi) parts.push('PSI as of ' + Haze.formatTime(data.psi.timestamp));
    if (data.pm25 && (!data.psi || data.pm25.timestamp !== data.psi.timestamp)) {
      parts.push('PM2.5 as of ' + Haze.formatTime(data.pm25.timestamp));
    }
    if (data.fetchedAt) parts.push('checked ' + fmtMs(data.fetchedAt));
    u.textContent = parts.join(' · ');
  }

  function setBanner(messages) {
    const b = $('banner');
    b.textContent = messages.join(' ');
    b.hidden = messages.length === 0;
  }

  function syncRegionOptions() {
    const sel = $('region');
    const keep = sel.value || settings.region;
    const regions = Haze.REGIONS.slice();
    const hasNational =
      (data.psi && 'national' in data.psi.values) || settings.region === 'national';
    if (hasNational) regions.push('national');
    sel.replaceChildren(...regions.map((r) => {
      const o = el('option', '', Haze.regionLabel(r));
      o.value = r;
      return o;
    }));
    sel.value = regions.includes(keep) ? keep : settings.region;
  }

  function renderSettings() {
    syncRegionOptions();
    $('region').value = settings.region;
    $('threshold').value = String(settings.threshold);
    $('save').textContent = settings.enabled ? 'Update alert' : 'Turn on alerts';
    $('off').hidden = !settings.enabled;
  }

  function backgroundNote() {
    if (background === 'on') {
      return ' Your phone may also check in the background about once an hour.';
    }
    return ' Alerts are checked while the app is open; this browser cannot check in the background.';
  }

  function enabledSummary() {
    return 'Alerts on: ' + Haze.regionLabel(settings.region) + ', 24-hr PSI of ' +
      settings.threshold + ' or more.' + backgroundNote();
  }

  // ---- data ----------------------------------------------------------------

  function loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (c && (c.psi || c.pm25)) data = c;
    } catch (e) { /* ignore corrupt cache */ }
  }
  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { /* storage full or blocked */ }
  }

  async function runAlerts() {
    if (!settings.enabled || !data.psi) return null;
    try {
      return await Haze.processReadings(data.psi, store, showAlert);
    } catch (e) {
      setStatus('Could not show the notification: ' + e.message, true);
      return null;
    }
  }

  function refresh() {
    if (inflight) return inflight;
    const btn = $('refresh');
    btn.classList.add('spin');
    btn.disabled = true;

    inflight = Haze.fetchAll().then(async (res) => {
      const msgs = [];
      if (res.psi) data.psi = res.psi;
      if (res.pm25) data.pm25 = res.pm25;
      if (res.psi || res.pm25) {
        data.fetchedAt = res.fetchedAt;
        saveCache();
      }
      if (!res.psi && !res.pm25) {
        console.warn('Haze Tracker fetch failed:', res.errors);
        msgs.push(navigator.onLine
          ? 'Could not reach NEA’s data service.'
          : 'You are offline.');
        if (data.psi || data.pm25) msgs.push('Showing the last saved readings.');
      } else {
        if (!res.psi) msgs.push('24-hr PSI is unavailable right now; showing the last saved value.');
        if (!res.pm25) msgs.push('1-hr PM2.5 is unavailable right now; showing the last saved value.');
        if (res.psi && Date.now() - Date.parse(res.psi.timestamp) > STALE_MS) {
          msgs.push('The latest NEA reading is from ' + Haze.formatTime(res.psi.timestamp) +
            ', so it may be delayed.');
        }
      }
      setBanner(msgs);
      syncRegionOptions();
      renderRegions();
      renderUpdated();
      if (res.psi) await runAlerts();
    }).finally(() => {
      btn.classList.remove('spin');
      btn.disabled = false;
      inflight = null;
    });
    return inflight;
  }

  // ---- notifications -------------------------------------------------------

  async function showAlert(a) {
    if (!('Notification' in window) || Notification.permission !== 'granted') {
      throw new Error('notification permission is not granted');
    }
    const opts = {
      body: a.body, tag: a.tag, renotify: true,
      icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', data: { url: './' }
    };
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      return reg.showNotification(a.title, opts);
    }
    new Notification(a.title, opts);
  }

  // Must be the first await in a click/submit handler so the browser treats it as a user gesture.
  async function ensurePermission() {
    if (isIos() && !isStandalone()) {
      return { ok: false, message: 'On iPhone and iPad, notifications only work once the app is on your Home Screen. Tap Share, then Add to Home Screen, open it from there and try again.' };
    }
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      return { ok: false, message: 'This browser does not support notifications.' };
    }
    let p = Notification.permission;
    if (p === 'default') p = await Notification.requestPermission();
    if (p !== 'granted') {
      return { ok: false, message: 'Notifications are blocked for this site. Allow them in your browser or phone settings, then try again.' };
    }
    return { ok: true };
  }

  async function registerBackground() {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (!('periodicSync' in reg)) return 'off';
      const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (perm.state !== 'granted') return 'off';
      await reg.periodicSync.register('psi-check', { minInterval: 60 * 60 * 1000 });
      return 'on';
    } catch (e) {
      return 'off';
    }
  }

  async function unregisterBackground() {
    try {
      const reg = await navigator.serviceWorker.ready;
      if ('periodicSync' in reg) await reg.periodicSync.unregister('psi-check');
    } catch (e) { /* nothing to unregister */ }
  }

  // ---- events --------------------------------------------------------------

  $('alert-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('threshold');
    const threshold = Number(input.value);
    if (input.value === '' || !Number.isInteger(threshold) || threshold < 1 || threshold > 500) {
      setStatus('Enter a whole number from 1 to 500.', true);
      input.focus();
      return;
    }
    const region = $('region').value;
    setStatus('');

    const perm = await ensurePermission();
    if (!perm.ok) { setStatus(perm.message, true); return; }

    settings = { region: region, threshold: threshold, enabled: true };
    await Haze.saveSettings(store, settings);
    background = await registerBackground();
    renderSettings();
    renderRegions();
    setStatus(enabledSummary());

    const r = await runAlerts();
    if (r && r.notified) {
      setStatus(enabledSummary() + ' It is already at that level, so a notification was sent.');
    }
  });

  $('off').addEventListener('click', async () => {
    settings.enabled = false;
    await Haze.saveSettings(store, settings);
    await unregisterBackground();
    renderSettings();
    renderRegions();
    setStatus('Alerts are off.');
  });

  $('test').addEventListener('click', async () => {
    const perm = await ensurePermission();
    if (!perm.ok) { setStatus(perm.message, true); return; }
    try {
      await showAlert({
        title: 'Haze Tracker test',
        body: 'Notifications are working on this device.',
        tag: 'haze-test'
      });
      setStatus('Test notification sent.');
    } catch (err) {
      setStatus('Could not show the notification: ' + err.message, true);
    }
  });

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => { $('threshold').value = chip.dataset.value; });
  });

  $('refresh').addEventListener('click', () => refresh());
  window.addEventListener('online', () => refresh());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - data.fetchedAt > 2 * 60 * 1000) refresh();
  });
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);

  // ---- install -------------------------------------------------------------

  function showInstall() {
    if (isStandalone()) return;
    if (installPrompt) {
      $('install-text').textContent =
        'Install Haze Tracker for one-tap access and, on supported phones, background alerts.';
      $('install-btn').hidden = false;
    } else if (isIos()) {
      $('install-text').textContent =
        'On iPhone or iPad: tap the Share button in Safari, then “Add to Home Screen”.';
    } else {
      return;
    }
    $('install').hidden = false;
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    showInstall();
  });
  window.addEventListener('appinstalled', () => { $('install').hidden = true; installPrompt = null; });
  $('install-btn').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('install').hidden = true;
  });

  // ---- start ---------------------------------------------------------------

  async function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker failed:', e));
    }
    loadCache();
    try { settings = await Haze.loadSettings(store); } catch (e) { /* use defaults */ }
    renderSettings();
    renderRegions();
    renderUpdated();
    showInstall();

    if (settings.enabled && 'Notification' in window && Notification.permission === 'granted') {
      background = await registerBackground();
      setStatus(enabledSummary());
    } else if (settings.enabled) {
      settings.enabled = false;
      await Haze.saveSettings(store, settings);
      renderSettings();
      setStatus('Notifications were turned off for this site, so alerts are off. Turn them on again below.', true);
    }
    refresh();
  }
  init();
})();
