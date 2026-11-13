/*
 * Haze Tracker shared logic.
 * Loaded by the page (index.html), the service worker (sw.js) and the Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Haze = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // data.gov.sg real-time NEA feeds. The v1 URLs are tried if the v2 ones fail.
  var ENDPOINTS = {
    psi: [
      'https://api-open.data.gov.sg/v2/real-time/api/psi',
      'https://api.data.gov.sg/v1/environment/psi'
    ],
    pm25: [
      'https://api-open.data.gov.sg/v2/real-time/api/pm25',
      'https://api.data.gov.sg/v1/environment/pm25'
    ]
  };

  var REGIONS = ['north', 'west', 'central', 'east', 'south'];
  var REGION_LABELS = {
    north: 'North', south: 'South', east: 'East', west: 'West', central: 'Central',
    national: 'Singapore overall'
  };

  // `tone` (0 = best ... 4 = worst) drives the colours in styles.css.
  // 24-hour PSI bands, per NEA.
  var PSI_BANDS = [
    { max: 50, label: 'Good', tone: 0 },
    { max: 100, label: 'Moderate', tone: 1 },
    { max: 200, label: 'Unhealthy', tone: 2 },
    { max: 300, label: 'Very unhealthy', tone: 3 },
    { max: Infinity, label: 'Hazardous', tone: 4 }
  ];
  // 1-hour PM2.5 (ug/m3) bands, per NEA.
  var PM25_BANDS = [
    { max: 55, label: 'Normal', tone: 0 },
    { max: 150, label: 'Elevated', tone: 2 },
    { max: 250, label: 'High', tone: 3 },
    { max: Infinity, label: 'Very high', tone: 4 }
  ];

  var DEFAULT_SETTINGS = { region: 'central', threshold: 100, enabled: false };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function band(bands, value) {
    if (!isNum(value)) return null;
    for (var i = 0; i < bands.length; i++) if (value <= bands[i].max) return bands[i];
    return null;
  }
  function psiBand(v) { return band(PSI_BANDS, v); }
  function pm25Band(v) { return band(PM25_BANDS, v); }

  function regionLabel(region) { return REGION_LABELS[region] || region; }

  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-SG', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Singapore'
    }).format(d).replace(/\s/g, '\u00a0'); // keep "11:46 am" on one line
  }

  // ---- Parsing -------------------------------------------------------------

  // Accepts the v2 shape ({data:{items}}) and the v1 shape ({items}).
  function parseReadings(json, key) {
    if (!json || typeof json !== 'object') throw new Error('Empty response');
    if (json.code !== undefined && json.code !== 0) {
      throw new Error(json.errorMsg || ('API error ' + json.code));
    }
    var items = (json.data && json.data.items) || json.items;
    if (!Array.isArray(items) || !items.length) throw new Error('No readings in response');

    var latest = items[0];
    items.forEach(function (it) {
      if (Date.parse(it.timestamp) > Date.parse(latest.timestamp)) latest = it;
    });

    var raw = latest.readings && latest.readings[key];
    if (!raw || typeof raw !== 'object') throw new Error('Missing ' + key);

    var values = {};
    Object.keys(raw).forEach(function (region) {
      var v = raw[region];
      if (v !== null && v !== '' && isNum(Number(v))) values[region.toLowerCase()] = Number(v);
    });
    if (!Object.keys(values).length) throw new Error('No values for ' + key);

    return {
      timestamp: latest.timestamp,
      updated: latest.updatedTimestamp || latest.update_timestamp || latest.timestamp,
      values: values
    };
  }

  // ---- Fetching ------------------------------------------------------------

  function fetchJson(url, fetchImpl, timeoutMs) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 10000) : null;
    return fetchImpl(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) { if (timer) clearTimeout(timer); return json; },
            function (err) { if (timer) clearTimeout(timer); throw err; });
  }

  function fetchMetric(kind, key, fetchImpl) {
    var errors = [];
    var urls = ENDPOINTS[kind];
    var chain = Promise.reject(new Error('start'));
    urls.forEach(function (url) {
      chain = chain.catch(function (e) {
        if (e.message !== 'start') errors.push(e.message);
        return fetchJson(url, fetchImpl).then(function (json) { return parseReadings(json, key); });
      });
    });
    return chain.catch(function (e) {
      errors.push(e.message);
      throw new Error(errors.join('; '));
    });
  }

  // Resolves to { psi, pm25, errors:{psi,pm25}, fetchedAt }. One feed failing does not hide the other.
  function fetchAll(fetchImpl) {
    var f = fetchImpl || function () { return fetch.apply(null, arguments); };
    return Promise.allSettled([
      fetchMetric('psi', 'psi_twenty_four_hourly', f),
      fetchMetric('pm25', 'pm25_one_hourly', f)
    ]).then(function (r) {
      return {
        psi: r[0].status === 'fulfilled' ? r[0].value : null,
        pm25: r[1].status === 'fulfilled' ? r[1].value : null,
        errors: {
          psi: r[0].status === 'rejected' ? r[0].reason.message : null,
          pm25: r[1].status === 'rejected' ? r[1].reason.message : null
        },
        fetchedAt: Date.now()
      };
    });
  }

  // ---- Alert rules ---------------------------------------------------------

  // Notify once when the value reaches the threshold. After that, stay quiet
  // until the value has dropped back below it ("re-armed").
  function evaluateAlert(value, threshold, armed) {
    if (!isNum(value)) return { notify: false, armed: armed };
    if (value >= threshold) return { notify: armed, armed: false };
    return { notify: false, armed: true };
  }

  function buildAlert(region, value, threshold, updatedIso) {
    var b = psiBand(value);
    var when = updatedIso ? ' Updated ' + formatTime(updatedIso) + '.' : '';
    return {
      title: 'Haze alert: ' + regionLabel(region) + ' PSI ' + value,
      body: '24-hour PSI (' + regionLabel(region) + ') is ' + value +
        (b ? ' – ' + b.label : '') + ', at or above your alert level of ' + threshold + '.' + when,
      tag: 'haze-alert'
    };
  }

  // ---- Storage -------------------------------------------------------------
  // IndexedDB is shared between the page and the service worker; localStorage is not.

  var dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var req = indexedDB.open('haze-tracker', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { dbPromise = null; reject(req.error); };
      });
    }
    return dbPromise;
  }
  function idbRequest(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = fn(db.transaction('kv', mode).objectStore('kv'));
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  var idbStore = {
    get: function (key) { return idbRequest('readonly', function (s) { return s.get(key); }); },
    set: function (key, value) { return idbRequest('readwrite', function (s) { return s.put(value, key); }); }
  };

  function createMemoryStore() {
    var data = {};
    return {
      get: function (k) { return Promise.resolve(data[k]); },
      set: function (k, v) { data[k] = v; return Promise.resolve(); }
    };
  }

  function loadSettings(store) {
    return store.get('settings').then(function (s) {
      var out = {};
      Object.keys(DEFAULT_SETTINGS).forEach(function (k) { out[k] = DEFAULT_SETTINGS[k]; });
      Object.keys(s || {}).forEach(function (k) { out[k] = s[k]; });
      return out;
    });
  }

  // Saving settings re-arms the alert so a fresh threshold can fire straight away.
  function saveSettings(store, settings) {
    return store.set('settings', settings).then(function () {
      return store.set('alertState', { armed: true });
    });
  }

  // ---- Checking ------------------------------------------------------------

  // Applies the alert rules to readings that are already fetched.
  // `notify(alert)` must return a promise; if it rejects, the alert stays armed so it is retried.
  function processReadings(psi, store, notify) {
    return loadSettings(store).then(function (settings) {
      if (!settings.enabled || !psi) return { notified: false };
      var value = psi.values[settings.region];
      return store.get('alertState').then(function (state) {
        var armed = !state || state.armed !== false;
        var r = evaluateAlert(value, settings.threshold, armed);
        var send = r.notify
          ? notify(buildAlert(settings.region, value, settings.threshold, psi.updated))
          : Promise.resolve();
        return send.then(function () {
          return store.set('alertState', { armed: r.armed, checkedAt: Date.now() });
        }).then(function () { return { notified: r.notify, value: value }; });
      });
    });
  }

  // Fetch + check. Used by the service worker's background sync.
  function runCheck(store, notify, fetchImpl) {
    return fetchAll(fetchImpl).then(function (data) {
      if (!data.psi) throw new Error(data.errors.psi || 'No PSI data');
      return processReadings(data.psi, store, notify);
    });
  }

  return {
    ENDPOINTS: ENDPOINTS, REGIONS: REGIONS, REGION_LABELS: REGION_LABELS,
    PSI_BANDS: PSI_BANDS, PM25_BANDS: PM25_BANDS, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    psiBand: psiBand, pm25Band: pm25Band, regionLabel: regionLabel, formatTime: formatTime,
    parseReadings: parseReadings, fetchAll: fetchAll,
    evaluateAlert: evaluateAlert, buildAlert: buildAlert,
    idbStore: idbStore, createMemoryStore: createMemoryStore,
    loadSettings: loadSettings, saveSettings: saveSettings,
    processReadings: processReadings, runCheck: runCheck
  };
});
