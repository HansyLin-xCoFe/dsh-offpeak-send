#!/usr/bin/env node
/**
 * dsh-offpeak-send · dependency-free self checks.
 *
 * Covers three layers without a browser:
 *   1. static: package manifest, patch, locale resources, icon, client module shape;
 *   2. syntax: the browser half parses as plain JavaScript;
 *   3. behavior: the pure helpers extracted from plugin/client.js between the
 *      PURE HELPERS markers (timezone math, off-peak window, presets, title,
 *      task filtering, error mapping).
 *
 * Run: node scripts/test-client.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Work in two layouts: the authoring checkout (`<root>/plugin/...`) and the
 * published repository (the package itself is the repo root).
 */
const PLUGIN = existsSync(path.join(ROOT, 'plugin', 'package.json')) ? path.join(ROOT, 'plugin') : ROOT;

let checks = 0;
const failures = [];

function check(name, fn) {
  checks += 1;
  try {
    fn();
  } catch (error) {
    failures.push(name + ' → ' + (error && error.message ? error.message : String(error)));
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error((label ? label + ': ' : '') + 'expected ' + e + ', got ' + a);
}

function ok(value, label) {
  if (!value) throw new Error((label || 'expected truthy') + ', got ' + JSON.stringify(value));
}

async function readText(file) {
  return readFileSync(file, 'utf8');
}

const source = await readText(path.join(PLUGIN, 'client.js'));
const manifest = JSON.parse(await readText(path.join(PLUGIN, 'package.json')));
const patch = await readText(path.join(PLUGIN, 'cordis.patch.yml'));
const zhLocale = JSON.parse(await readText(path.join(PLUGIN, 'locale', 'zh.json')));
const enLocale = JSON.parse(await readText(path.join(PLUGIN, 'locale', 'en.json')));
const icon = await readText(path.join(PLUGIN, 'icon.svg'));
const hostHalf = await readText(path.join(PLUGIN, 'index.js'));

/* ---------------- 1. static layer ---------------- */

check('manifest name matches module id', () => {
  eq(manifest.name, 'dsh-offpeak-send');
  ok(source.includes("id: 'dsh-offpeak-send'"), 'module loader id');
});

check('manifest declares the bundle patch and client half', () => {
  eq(manifest.dsh.bundle.patch, './cordis.patch.yml');
  eq(manifest.dsh.client.platform, 'web');
  eq(manifest.dsh.client.immediately, true);
});

check('manifest exports the client, locale entries and icon', () => {
  eq(manifest.exports['./client'], './client.js');
  eq(manifest.exports['.'], './index.js');
  eq(manifest.exports['./icon'], './icon.svg');
  ok(manifest.exports['./locale/*.json'], 'locale export');
});

check('manifest files list covers every shipped file', () => {
  const files = manifest.files || [];
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md']) {
    ok(files.includes(required), 'files is missing ' + required);
  }
  ok(files.includes('locale/*.json'), 'files is missing locale/*.json');
});

check('patch inserts exactly one row named after the package', () => {
  const inserts = patch.split('\n').filter((line) => line.trim().startsWith('- id:'));
  eq(inserts.length, 1);
  ok(/id:\s*dsh-offpeak-send/.test(patch), 'row id');
  ok(/name:\s*dsh-offpeak-send/.test(patch), 'row name');
});

check('host half is inert', () => {
  ok(/export function apply\(\)\s*\{\s*\}/.test(hostHalf), 'apply() must be empty');
  ok(!/\bctx\./.test(hostHalf), 'host half must not touch ctx');
});

check('locale resources carry meta.title and meta.description', () => {
  for (const [label, locale] of [['zh', zhLocale], ['en', enLocale]]) {
    ok(locale.meta && typeof locale.meta.title === 'string' && locale.meta.title.length > 0, label + ' meta.title');
    ok(locale.meta && typeof locale.meta.description === 'string' && locale.meta.description.length > 0, label + ' meta.description');
  }
});

check('icon is a small self-contained svg', () => {
  ok(icon.trim().startsWith('<svg'), 'svg root');
  ok(icon.includes('</svg>'), 'svg closed');
  const size = statSync(path.join(PLUGIN, 'icon.svg')).size;
  ok(size > 0 && size < 256 * 1024, 'icon must stay under the 256 KiB limit, got ' + size);
});

check('client half never imports another Harness Client package', () => {
  ok(!/require\(['"]@deepseek-ai\//.test(source), 'must not require Harness Client modules');
  ok(!/^\s*(import|export)\s/m.test(source), 'plain script must not use import/export');
});

check('client half declares the services it consumes', () => {
  for (const service of ['slots', 'locale', 'remote', 'remote.schedule', 'remoteAccess']) {
    ok(new RegExp("'" + service.replace('.', '\\.') + "'").test(source), 'missing inject entry ' + service);
  }
});

check('client half no longer references the superseded 00:30-08:30 window', () => {
  ok(!/OFF_PEAK|'\d\d:\d\d'/.test(source), 'stale off-peak defaults');
});

check('client half registers both composer surfaces', () => {
  ok(source.includes("'conversation.input.right'"), 'composer control slot');
  ok(source.includes("'conversation.composer.dock'"), 'ambient dock slot');
});

check('every visible string key exists in both dictionaries', () => {
  const zhStart = source.indexOf('    const zh = {');
  const enStart = source.indexOf('    const en = {');
  const zhEnd = source.indexOf('\n    };', zhStart);
  const enEnd = source.indexOf('\n    };', enStart);
  ok(zhStart >= 0 && enStart > zhStart && zhEnd > zhStart && enEnd > enStart, 'dictionary blocks');
  const keysOf = (block) => {
    const keys = new Set();
    const re = /'([^']+)':/g;
    let match;
    while ((match = re.exec(block)) !== null) keys.add(match[1]);
    return keys;
  };
  const zhKeys = keysOf(source.slice(zhStart, zhEnd));
  const enKeys = keysOf(source.slice(enStart, enEnd));
  const used = new Set();
  const usedRe = /\bt\('([^']+)'/g;
  let match;
  while ((match = usedRe.exec(source)) !== null) used.add(match[1]);
  eq([...used].filter((key) => !zhKeys.has(key)), [], 'keys missing from zh');
  eq([...used].filter((key) => !enKeys.has(key)), [], 'keys missing from en');
  eq([...zhKeys].filter((key) => !enKeys.has(key)), [], 'zh-only keys');
  eq([...enKeys].filter((key) => !zhKeys.has(key)), [], 'en-only keys');
});
check('every ofsend/offsend helper call has a matching function definition', () => {
  const definitions = new Set();
  const defRe = /function\s+((?:ofsend|offsend)[A-Za-z0-9_]*)\s*\(/g;
  let match;
  while ((match = defRe.exec(source)) !== null) definitions.add(match[1]);
  ok(definitions.size >= 20, 'expected many helper definitions, got ' + definitions.size);
  const missing = new Set();
  const callRe = /\b((?:ofsend|offsend)[A-Za-z0-9_]*)\s*\(/g;
  while ((match = callRe.exec(source)) !== null) {
    if (!definitions.has(match[1])) missing.add(match[1]);
  }
  eq([...missing], [], 'helpers called without a definition');
});
/* ---------------- 2. syntax layer ---------------- */

let helpers = null;

check('browser half parses as plain JavaScript', () => {
  // Parsing only: the factory body is never executed here.
  new Function(source);
});

check('pure helper markers exist once each', () => {
  eq(source.split('/* BEGIN PURE HELPERS').length, 2);
  eq(source.split('/* END PURE HELPERS */').length, 2);
});

check('pure helpers evaluate in isolation', () => {
  const beginToken = '/* BEGIN PURE HELPERS (tested by scripts/test-client.mjs) */';
  const begin = source.indexOf(beginToken);
  const end = source.indexOf('/* END PURE HELPERS */');
  ok(begin >= 0 && end > begin, 'markers');
  const body = source.slice(begin + beginToken.length, end);
  const exported = [
    'NS', 'TITLE_TAG', 'TITLE_MAX', 'MIN_LEAD_MS', 'PRICING',
    'ofsendIsPeakAt', 'ofsendIsOffPeakAt', 'ofsendIsHoliday',
    'ofsendPeakWindowEnd', 'ofsendNextPeakStart', 'ofsendCheapPresetTarget',
    'ofsendWallToInstant', 'ofsendZonedParts', 'ofsendOffsetMinutes',
    'ofsendEnsureFuture', 'ofsendFormatWhen', 'ofsendDurationParts',
    'ofsendTitle', 'ofsendIsOurs', 'ofsendPendingFor', 'ofsendPresetTarget',
    'ofsendErrorKey', 'ofsendLocalInputValue', 'ofsendParseLocalInput',
  ];
  helpers = new Function(
    body + '\nreturn {' + exported.join(',') + '};',
  )();
  ok(helpers && typeof helpers.ofsendIsPeakAt === 'function', 'helpers returned');
});

/* ---------------- 3. behavior layer ---------------- */

function h(name, fn) {
  check(name, () => {
    if (!helpers) throw new Error('helpers unavailable');
    fn(helpers);
  });
}

h('pricing rule stores Beijing peak windows, not an off-peak pair', (H) => {
  eq(H.PRICING.timeZone, 'Asia/Shanghai');
  eq(H.PRICING.peakWindows.map(function (window) {
    return [window.startHour, window.startMinute, window.endHour, window.endMinute];
  }), [[9, 0, 12, 0], [14, 0, 18, 0]]);
  eq(H.PRICING.holidays, []);
  eq(H.PRICING.boundaryMarginMs, 120000);
});

h('zoned parts read Beijing wall clock and weekday', (H) => {
  const parts = H.ofsendZonedParts(Date.parse('2026-11-09T05:37:42Z'), 'Asia/Shanghai');
  eq([parts.year, parts.month, parts.day, parts.hour, parts.minute], [2026, 11, 9, 13, 37]);
  eq(parts.weekday, 1, 'Monday');
  eq(H.ofsendZonedParts(Date.parse('2026-11-07T02:00:00Z'), 'Asia/Shanghai').weekday, 6, 'Saturday');
});

h('wall clock converts back to the same instant', (H) => {
  const instant = H.ofsendWallToInstant(2026, 11, 10, 0, 30, 'Asia/Shanghai');
  eq(new Date(instant).toISOString(), '2026-11-09T16:30:00.000Z');
});

h('peak membership follows the weekday windows', (H) => {
  const at = (iso) => H.ofsendIsPeakAt(Date.parse(iso));
  eq(at('2026-11-09T00:59:00Z'), false, '08:59 Beijing');
  eq(at('2026-11-09T01:00:00Z'), true, '09:00 Beijing');
  eq(at('2026-11-09T03:59:59Z'), true, '11:59 Beijing');
  eq(at('2026-11-09T04:00:00Z'), false, '12:00 Beijing');
  eq(at('2026-11-09T05:59:59Z'), false, '13:59 Beijing');
  eq(at('2026-11-09T06:00:00Z'), true, '14:00 Beijing');
  eq(at('2026-11-09T09:59:59Z'), true, '17:59 Beijing');
  eq(at('2026-11-09T10:00:00Z'), false, '18:00 Beijing');
  eq(H.ofsendIsOffPeakAt(Date.parse('2026-11-09T04:00:00Z')), true);
});

h('weekends are off-peak all day', (H) => {
  eq(H.ofsendIsPeakAt(Date.parse('2026-11-07T02:00:00Z')), false, 'Saturday 10:00');
  eq(H.ofsendIsPeakAt(Date.parse('2026-11-08T07:00:00Z')), false, 'Sunday 15:00');
  eq(H.ofsendIsOffPeakAt(Date.parse('2026-11-08T07:00:00Z')), true);
});

h('listed Chinese public holidays are off-peak', (H) => {
  const holidayRule = Object.assign({}, H.PRICING, { holidays: ['2026-11-09'] });
  eq(H.ofsendIsHoliday({ year: 2026, month: 11, day: 9 }, holidayRule), true);
  eq(H.ofsendIsHoliday({ year: 2026, month: 11, day: 10 }, holidayRule), false);
  eq(H.ofsendIsPeakAt(Date.parse('2026-11-09T02:00:00Z'), holidayRule), false, '10:00 on a holiday');
  eq(H.ofsendIsPeakAt(Date.parse('2026-11-09T02:00:00Z')), true, '10:00 on a normal Monday');
});

h('current peak window end is resolved in Beijing time', (H) => {
  const iso = (instant) => new Date(instant).toISOString();
  eq(iso(H.ofsendPeakWindowEnd(Date.parse('2026-11-09T02:00:00Z'))), '2026-11-09T04:00:00.000Z');
  eq(iso(H.ofsendPeakWindowEnd(Date.parse('2026-11-09T07:00:00Z'))), '2026-11-09T10:00:00.000Z');
  eq(Number.isFinite(H.ofsendPeakWindowEnd(Date.parse('2026-11-09T04:30:00Z'))), false);
});

h('cheap preset waits for the peak to end plus a safety margin', (H) => {
  const iso = (instant) => new Date(instant).toISOString();
  eq(iso(H.ofsendCheapPresetTarget(Date.parse('2026-11-09T02:00:00Z'))), '2026-11-09T04:02:00.000Z', '10:00 -> 12:02');
  eq(iso(H.ofsendCheapPresetTarget(Date.parse('2026-11-09T03:59:00Z'))), '2026-11-09T04:02:00.000Z', '11:59 -> 12:02');
  eq(iso(H.ofsendCheapPresetTarget(Date.parse('2026-11-09T07:00:00Z'))), '2026-11-09T10:02:00.000Z', '15:00 -> 18:02');
  eq(iso(H.ofsendCheapPresetTarget(Date.parse('2026-11-13T09:59:00Z'))), '2026-11-13T10:02:00.000Z', 'Friday 17:59 -> 18:02');
});

h('cheap preset is one minute out when already off-peak', (H) => {
  const mondayEvening = Date.parse('2026-11-09T12:00:00Z');
  eq(H.ofsendCheapPresetTarget(mondayEvening), mondayEvening + 60000);
  const saturday = Date.parse('2026-11-07T02:00:00Z');
  eq(H.ofsendCheapPresetTarget(saturday), saturday + 60000);
  const nearlyPeak = Date.parse('2026-11-09T00:59:30Z'); // 08:59:30 Beijing, off-peak but +60s crosses 09:00
  eq(new Date(H.ofsendCheapPresetTarget(nearlyPeak)).toISOString(), '2026-11-09T04:02:00.000Z', 'crossing into morning peak -> 12:02');
  const nearlyAfternoon = Date.parse('2026-11-09T05:59:00Z'); // 13:59 Beijing, off-peak but +60s crosses 14:00
  eq(new Date(H.ofsendCheapPresetTarget(nearlyAfternoon)).toISOString(), '2026-11-09T10:02:00.000Z', 'crossing into afternoon peak -> 18:02');
});

h('cheap preset never targets a peak instant across whole days', (H) => {
  const days = [Date.parse('2026-11-08T16:00:00Z'), Date.parse('2026-11-06T16:00:00Z')]; // Monday + Saturday, 00:00 Beijing
  for (const start of days) {
    for (let second = 0; second < 24 * 3600; second += 30) {
      const now = start + second * 1000;
      const target = H.ofsendCheapPresetTarget(now);
      if (H.ofsendIsPeakAt(target)) {
        throw new Error('peak target: now=' + new Date(now).toISOString() + ' -> ' + new Date(target).toISOString());
      }
    }
  }
});
h('next peak start skips nights, the lunch gap and weekends', (H) => {
  const iso = (instant) => new Date(instant).toISOString();
  eq(iso(H.ofsendNextPeakStart(Date.parse('2026-11-09T04:30:00Z'))), '2026-11-09T06:00:00.000Z', 'lunch gap -> 14:00');
  eq(iso(H.ofsendNextPeakStart(Date.parse('2026-11-09T12:00:00Z'))), '2026-11-10T01:00:00.000Z', 'Monday evening -> Tuesday 09:00');
  eq(iso(H.ofsendNextPeakStart(Date.parse('2026-11-13T12:00:00Z'))), '2026-11-16T01:00:00.000Z', 'Friday evening -> Monday 09:00');
});

h('ensureFuture never returns an already-past target', (H) => {
  const now = Date.parse('2026-11-09T00:00:00Z');
  eq(H.ofsendEnsureFuture(now - 5000, now), now + H.MIN_LEAD_MS);
  eq(H.ofsendEnsureFuture(now + 60000, now), now + 60000);
});

h('local datetime input round-trips', (H) => {
  const instant = new Date(2026, 10, 10, 0, 30).getTime();
  const value = H.ofsendLocalInputValue(instant);
  eq(value, '2026-11-10T00:30');
  eq(H.ofsendParseLocalInput(value), instant);
  eq(Number.isFinite(H.ofsendParseLocalInput('')), false);
  eq(Number.isFinite(H.ofsendParseLocalInput('not-a-date')), false);
});

h('when labels distinguish today, tomorrow and later', (H) => {
  const now = new Date(2026, 10, 9, 13, 37).getTime();
  const today = H.ofsendFormatWhen(new Date(2026, 10, 9, 15, 5).getTime(), now);
  eq([today.day, today.clock, today.date], ['today', '15:05', '11-09']);
  const tomorrow = H.ofsendFormatWhen(new Date(2026, 10, 10, 0, 30).getTime(), now);
  eq([tomorrow.day, tomorrow.clock], ['tomorrow', '00:30']);
  const later = H.ofsendFormatWhen(new Date(2026, 10, 12, 0, 30).getTime(), now);
  eq([later.day, later.date], ['other', '11-12']);
});

h('duration parts and labels are sane', (H) => {
  eq(H.ofsendDurationParts(0), { days: 0, hours: 0, minutes: 0, totalMinutes: 0 });
  eq(H.ofsendDurationParts(90 * 60000), { days: 0, hours: 1, minutes: 30, totalMinutes: 90 });
  eq(H.ofsendDurationParts(26 * 3600000), { days: 1, hours: 2, minutes: 0, totalMinutes: 1560 });
});

h('task titles carry the marker and stay within 120 characters', (H) => {
  const long = 'x'.repeat(400);
  const title = H.ofsendTitle('定时发送', long);
  ok(title.startsWith(H.TITLE_TAG), 'marker');
  ok(title.includes('定时发送'), 'prefix');
  ok(title.length <= H.TITLE_MAX, 'length ' + title.length);
  ok(title.endsWith('\u2026'), 'truncation ellipsis');
  const short = H.ofsendTitle('Scheduled send', '  hello\n\n world  ');
  eq(short, H.TITLE_TAG + ' Scheduled send \u00b7 hello world');
});

h('only marked titles count as ours', (H) => {
  eq(H.ofsendIsOurs({ title: H.TITLE_TAG + ' x' }), true);
  eq(H.ofsendIsOurs({ title: 'other' }), false);
  eq(H.ofsendIsOurs(null), false);
  eq(H.ofsendIsOurs({}), false);
});

h('pending filter keeps active, ours, current-Session tasks soonest first', (H) => {
  const ours = (id, sessionId, status, at, title) => ({
    id,
    title: title || H.TITLE_TAG + ' x',
    status,
    target: { kind: 'session', sessionId },
    scheduledAt: at,
  });
  const items = [
    ours('late', 's1', 'active', '2026-11-10T16:30:00.000Z'),
    ours('early', 's1', 'active', '2026-11-09T16:30:00.000Z'),
    ours('paused', 's1', 'paused', '2026-11-09T17:30:00.000Z'),
    ours('foreign-session', 's2', 'active', '2026-11-09T18:30:00.000Z'),
    ours('foreign-title', 's1', 'active', '2026-11-09T19:30:00.000Z', 'agent reminder'),
    { id: 'new-once', title: H.TITLE_TAG + ' x', status: 'active', target: { kind: 'new_once', sessionId: 's1' } },
    null,
  ];
  const pending = H.ofsendPendingFor(items, 's1');
  eq(pending.map((item) => item.id), ['early', 'late']);
  eq(H.ofsendPendingFor(items, 'missing'), []);
  eq(H.ofsendPendingFor(null, 's1'), []);
});

h('presets resolve to the expected instants', (H) => {
  const now = Date.parse('2026-11-09T02:00:00Z'); // Monday 10:00 Beijing, inside peak
  eq(H.ofsendPresetTarget('plus1h', '', now), now + 3600000);
  eq(new Date(H.ofsendPresetTarget('cheap', '', now)).toISOString(), '2026-11-09T04:02:00.000Z');
  const custom = H.ofsendLocalInputValue(now + 5 * 3600000);
  eq(H.ofsendPresetTarget('custom', custom, now), H.ofsendParseLocalInput(custom));
  eq(Number.isFinite(H.ofsendPresetTarget('custom', 'bad', now)), false);
});

h('remote failures map to locale keys', (H) => {
  eq(H.ofsendErrorKey({ code: 'schedule/input-invalid', details: { code: 'not_future' } }), 'error.notFuture');
  eq(H.ofsendErrorKey({ code: 'schedule/input-invalid', details: { code: 'frequency_too_high' } }), 'error.frequency');
  eq(H.ofsendErrorKey({ code: 'schedule/input-invalid', details: { code: 'invalid_time_zone' } }), 'error.invalidTime');
  eq(H.ofsendErrorKey({ code: 'schedule/input-invalid', details: { code: 'invalid_prompt' } }), 'error.failed');
  eq(H.ofsendErrorKey({ code: 'schedule/target-archived' }), 'error.archived');
  eq(H.ofsendErrorKey({ code: 'schedule/input-invalid', details: { code: 'subagent_session' } }), 'error.subagent');
  eq(H.ofsendErrorKey({ code: 'something/else' }), 'error.failed');
  eq(H.ofsendErrorKey(null), 'error.failed');
});
/* ---------------- report ---------------- */

if (failures.length > 0) {
  console.error('dsh-offpeak-send self check: ' + failures.length + ' failed, ' + (checks - failures.length) + ' passed, ' + checks + ' total\n');
  for (const failure of failures) console.error('  ✗ ' + failure);
  process.exitCode = 1;
} else {
  console.log('dsh-offpeak-send self check: all ' + checks + ' checks passed');
}
