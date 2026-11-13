// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const Haze = require('../lib.js');

// Response shapes as returned by NEA's data.gov.sg endpoints.
const v2Psi = (ts, central) => ({
  code: 0, errorMsg: '',
  data: {
    regionMetadata: [{ name: 'north', labelLocation: { latitude: 1.41803, longitude: 103.82 } }],
    items: [{
      date: ts.slice(0, 10), timestamp: ts, updatedTimestamp: ts.replace(':00:00', ':01:00'),
      readings: { psi_twenty_four_hourly: { north: 61, south: 40, east: 55, west: 70, central: central } }
    }]
  }
});
const v2Pm25 = {
  code: 0, errorMsg: '',
  data: { items: [{
    date: '2026-11-13', timestamp: '2026-11-13T00:00:00+08:00', updatedTimestamp: '2026-11-13T00:01:01+08:00',
    readings: { pm25_one_hourly: { north: 28, south: 17, west: 28, east: 18, central: 20 } }
  }] }
};
const v1Psi = {
  items: [{
    timestamp: '2026-11-13T09:00:00+08:00', update_timestamp: '2026-11-13T09:01:00+08:00',
    readings: { psi_twenty_four_hourly: { national: 52, north: 41, south: 35, east: 52, west: 37, central: 51 } }
  }],
  api_info: { status: 'healthy' }
};

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const fail = (status) => Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) });

test('PSI bands follow NEA ranges', () => {
  const cases = [[0, 'Good'], [50, 'Good'], [51, 'Moderate'], [100, 'Moderate'], [101, 'Unhealthy'],
    [200, 'Unhealthy'], [201, 'Very unhealthy'], [300, 'Very unhealthy'], [301, 'Hazardous'], [450, 'Hazardous']];
  for (const [v, label] of cases) assert.equal(Haze.psiBand(v).label, label, 'PSI ' + v);
  assert.equal(Haze.psiBand(undefined), null);
  assert.equal(Haze.psiBand(null), null);
  assert.equal(Haze.psiBand(NaN), null);
});

test('PM2.5 bands follow NEA ranges', () => {
  const cases = [[0, 'Normal'], [55, 'Normal'], [56, 'Elevated'], [150, 'Elevated'], [151, 'High'],
    [250, 'High'], [251, 'Very high']];
  for (const [v, label] of cases) assert.equal(Haze.pm25Band(v).label, label, 'PM2.5 ' + v);
});

test('parseReadings handles the v2 shape', () => {
  const r = Haze.parseReadings(v2Psi('2026-11-13T09:00:00+08:00', 51), 'psi_twenty_four_hourly');
  assert.equal(r.values.central, 51);
  assert.equal(r.values.north, 61);
  assert.equal(r.timestamp, '2026-11-13T09:00:00+08:00');
  assert.equal(r.updated, '2026-11-13T09:01:00+08:00');
});

test('parseReadings handles the v1 shape and a national value', () => {
  const r = Haze.parseReadings(v1Psi, 'psi_twenty_four_hourly');
  assert.equal(r.values.national, 52);
  assert.equal(r.updated, '2026-11-13T09:01:00+08:00');
});

test('parseReadings picks the newest item and drops non-numeric values', () => {
  const json = { code: 0, data: { items: [
    { timestamp: '2026-11-13T08:00:00+08:00', readings: { pm25_one_hourly: { north: 1 } } },
    { timestamp: '2026-11-13T10:00:00+08:00', readings: { pm25_one_hourly: { north: 3, south: null, east: 'x', west: '7' } } }
  ] } };
  const r = Haze.parseReadings(json, 'pm25_one_hourly');
  assert.deepEqual(r.values, { north: 3, west: 7 });
});

test('parseReadings rejects bad responses', () => {
  assert.throws(() => Haze.parseReadings(null, 'x'), /Empty/);
  assert.throws(() => Haze.parseReadings({ code: 1, errorMsg: 'rate limited' }, 'x'), /rate limited/);
  assert.throws(() => Haze.parseReadings({ data: { items: [] } }, 'x'), /No readings/);
  assert.throws(() => Haze.parseReadings({ data: { items: [{ timestamp: 't', readings: {} }] } }, 'x'), /Missing/);
});

test('fetchAll returns both feeds', async () => {
  const f = (url) => ok(url.includes('/psi') ? v2Psi('2026-11-13T09:00:00+08:00', 51) : v2Pm25);
  const r = await Haze.fetchAll(f);
  assert.equal(r.psi.values.central, 51);
  assert.equal(r.pm25.values.central, 20);
  assert.deepEqual(r.errors, { psi: null, pm25: null });
});

test('fetchAll falls back to the v1 endpoint', async () => {
  const seen = [];
  const f = (url) => {
    seen.push(url);
    if (url.includes('api-open')) return fail(503);
    return ok(url.includes('psi') ? v1Psi : { items: [{ timestamp: 't', readings: { pm25_one_hourly: { central: 9 } } }] });
  };
  const r = await Haze.fetchAll(f);
  assert.equal(r.psi.values.central, 51);
  assert.equal(r.pm25.values.central, 9);
  assert.ok(seen.some((u) => u.startsWith('https://api.data.gov.sg/v1/')));
});

test('one failing feed does not hide the other', async () => {
  const f = (url) => (url.includes('/psi') || url.includes('/pm25') ? (url.includes('/pm25') ? fail(500) : ok(v2Psi('2026-11-13T09:00:00+08:00', 51))) : fail(500));
  const r = await Haze.fetchAll(f);
  assert.ok(r.psi);
  assert.equal(r.pm25, null);
  assert.match(r.errors.pm25, /HTTP 500/);
});

test('fetchAll reports errors when everything fails', async () => {
  const r = await Haze.fetchAll(() => Promise.reject(new Error('Failed to fetch')));
  assert.equal(r.psi, null);
  assert.equal(r.pm25, null);
  assert.match(r.errors.psi, /Failed to fetch/);
});

test('evaluateAlert fires once on crossing, then re-arms below the threshold', () => {
  let s = { armed: true };
  const step = (v) => { const r = Haze.evaluateAlert(v, 100, s.armed); s.armed = r.armed; return r.notify; };
  assert.equal(step(80), false);
  assert.equal(step(100), true, 'reaching the threshold fires');
  assert.equal(step(120), false, 'stays quiet while above');
  assert.equal(step(100), false);
  assert.equal(step(99), false, 'dropping below re-arms');
  assert.equal(step(101), true, 'fires again on the next crossing');
});

test('evaluateAlert ignores missing readings', () => {
  assert.deepEqual(Haze.evaluateAlert(undefined, 100, true), { notify: false, armed: true });
  assert.deepEqual(Haze.evaluateAlert(NaN, 100, false), { notify: false, armed: false });
});

test('buildAlert words the notification clearly', () => {
  const a = Haze.buildAlert('north', 112, 100, '2026-11-13T21:01:00+08:00');
  assert.equal(a.title, 'Haze alert: North PSI 112');
  assert.match(a.body, /112 – Unhealthy/);
  assert.match(a.body, /alert level of 100/);
  assert.match(a.body, /9:01\spm/i);
  assert.equal(Haze.buildAlert('national', 120, 100).title, 'Haze alert: Singapore overall PSI 120');
});

test('processReadings notifies once for the chosen region and re-arms', async () => {
  const store = Haze.createMemoryStore();
  await Haze.saveSettings(store, { region: 'west', threshold: 70, enabled: true });
  const sent = [];
  const notify = (a) => { sent.push(a); return Promise.resolve(); };
  const reading = (west) => ({ timestamp: 't', updated: '2026-11-13T09:01:00+08:00', values: { west, north: 200 } });

  assert.equal((await Haze.processReadings(reading(60), store, notify)).notified, false);
  assert.equal((await Haze.processReadings(reading(70), store, notify)).notified, true);
  assert.equal((await Haze.processReadings(reading(90), store, notify)).notified, false);
  assert.equal((await Haze.processReadings(reading(65), store, notify)).notified, false);
  assert.equal((await Haze.processReadings(reading(71), store, notify)).notified, true);
  assert.equal(sent.length, 2);
  assert.match(sent[0].title, /West PSI 70/, 'north at 200 must not trigger a west alert');
});

test('processReadings does nothing when alerts are off', async () => {
  const store = Haze.createMemoryStore();
  await Haze.saveSettings(store, { region: 'west', threshold: 10, enabled: false });
  let calls = 0;
  const r = await Haze.processReadings({ timestamp: 't', values: { west: 99 } }, store, () => { calls++; return Promise.resolve(); });
  assert.equal(r.notified, false);
  assert.equal(calls, 0);
});

test('a failed notification stays armed so it is retried', async () => {
  const store = Haze.createMemoryStore();
  await Haze.saveSettings(store, { region: 'east', threshold: 50, enabled: true });
  const reading = { timestamp: 't', values: { east: 60 } };
  await assert.rejects(Haze.processReadings(reading, store, () => Promise.reject(new Error('blocked'))), /blocked/);
  let sent = 0;
  const r = await Haze.processReadings(reading, store, () => { sent++; return Promise.resolve(); });
  assert.equal(r.notified, true);
  assert.equal(sent, 1);
});

test('saving settings re-arms the alert', async () => {
  const store = Haze.createMemoryStore();
  await Haze.saveSettings(store, { region: 'east', threshold: 50, enabled: true });
  const reading = { timestamp: 't', values: { east: 60 } };
  const notify = () => Promise.resolve();
  assert.equal((await Haze.processReadings(reading, store, notify)).notified, true);
  assert.equal((await Haze.processReadings(reading, store, notify)).notified, false);
  await Haze.saveSettings(store, { region: 'east', threshold: 55, enabled: true });
  assert.equal((await Haze.processReadings(reading, store, notify)).notified, true);
});

test('runCheck fetches and alerts end to end', async () => {
  const store = Haze.createMemoryStore();
  await Haze.saveSettings(store, { region: 'central', threshold: 51, enabled: true });
  const f = (url) => ok(url.includes('/psi') ? v2Psi('2026-11-13T09:00:00+08:00', 51) : v2Pm25);
  const sent = [];
  const r = await Haze.runCheck(store, (a) => { sent.push(a); return Promise.resolve(); }, f);
  assert.equal(r.notified, true);
  assert.equal(sent[0].title, 'Haze alert: Central PSI 51');
  await assert.rejects(Haze.runCheck(store, () => Promise.resolve(), () => fail(500)), /HTTP 500/);
});
