/**
 * dsh-offpeak-send — browser half.
 *
 * Adds a clock control to the left of the composer submit action
 * (`conversation.input.right`). The user types a message, opens the control,
 * picks a send time (wait out the Beijing peak-price window, +1 hour, or a
 * custom local time), and the draft is handed to the shipped Host `schedule` service
 * as a one-shot task targeting the current Session. The Host then delivers the
 * message into that Session's inbox at the chosen instant — even when this page
 * is closed — so the model spends its tokens inside the off-peak price window.
 *
 * A second, ambient entry under the composer card (`conversation.composer.dock`)
 * shows the nearest pending scheduled send for this Session with a live
 * countdown and a two-step cancel.
 *
 * The Host half (index.js) registers nothing: everything goes through the
 * existing `schedule` service's Remote namespace.
 */
window.__ModuleLoader__.load({
  id: 'dsh-offpeak-send',
  factory(require) {
    'use strict';

    const React = require('react');
    let ReactDOM = null;
    try {
      ReactDOM = require('react-dom');
    } catch (error) {
      ReactDOM = null;
    }

    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

    /* BEGIN PURE HELPERS (tested by scripts/test-client.mjs) */

    /** Locale namespace and the durable title marker used to recognize our tasks. */
    const NS = 'dsh-offpeak-send';
    const TITLE_TAG = '\u23f1';
    const TITLE_MAX = 120;
    const MIN_LEAD_MS = 60000;

    /**
     * DeepSeek peak / off-peak pricing rule (official, checked 2026-11-09).
     *
     * Off-peak ("valley") tokens cost 50% of the peak price. Peak is Beijing
     * time Monday–Friday 09:00–12:00 and 14:00–18:00, excluding Chinese public
     * holidays; everything else is off-peak — weekends, public holidays, the
     * 12:00–14:00 lunch gap, evenings and nights.
     *
     * Keep this rule in Beijing time: the official billing basis is
     * Asia/Shanghai no matter what the browser time zone says.
     *
     * `holidays` lists CN public holidays as Beijing `YYYY-MM-DD` dates. It is
     * empty by default: an unlisted weekday holiday then counts as PEAK, which
     * can only make a preset wait longer — never send inside a real peak
     * window. Add official holiday dates here to make those days all off-peak.
     */
    const PRICING = Object.freeze({
      timeZone: 'Asia/Shanghai',
      peakWindows: Object.freeze([
        Object.freeze({ startHour: 9, startMinute: 0, endHour: 12, endMinute: 0 }),
        Object.freeze({ startHour: 14, startMinute: 0, endHour: 18, endMinute: 0 }),
      ]),
      holidays: Object.freeze([]),
      /** Safety margin past a peak boundary, so clock jitter cannot bill peak. */
      boundaryMarginMs: 2 * 60000,
    });

    const OFSEND_FORMATTERS = new Map();

    function ofsendFormatter(timeZone) {
      let formatter = OFSEND_FORMATTERS.get(timeZone);
      if (formatter === undefined) {
        formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: timeZone,
          hourCycle: 'h23',
          hour12: false,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        OFSEND_FORMATTERS.set(timeZone, formatter);
      }
      return formatter;
    }

    /** Wall-clock parts of one instant in a named IANA time zone. */
    function ofsendZonedParts(instant, timeZone) {
      const parts = ofsendFormatter(timeZone).formatToParts(new Date(instant));
      const out = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part.type === 'year') out.year = Number(part.value);
        else if (part.type === 'month') out.month = Number(part.value);
        else if (part.type === 'day') out.day = Number(part.value);
        else if (part.type === 'hour') out.hour = Number(part.value) % 24;
        else if (part.type === 'minute') out.minute = Number(part.value);
        else if (part.type === 'second') out.second = Number(part.value);
      }
      out.weekday = new Date(Date.UTC(out.year, out.month - 1, out.day)).getUTCDay();
      return out;
    }

    /** Beijing calendar date key (`YYYY-MM-DD`) used by the holiday list. */
    function ofsendDateKey(parts) {
      return parts.year + '-' + ofsendPad2(parts.month) + '-' + ofsendPad2(parts.day);
    }

    /** Offset of one time zone at one instant, in minutes east of UTC. */
    function ofsendOffsetMinutes(instant, timeZone) {
      const parts = ofsendZonedParts(instant, timeZone);
      const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
      return Math.round((asUtc - instant) / 60000);
    }

    /** Convert a wall-clock reading in one IANA zone to an epoch instant. */
    function ofsendWallToInstant(year, month, day, hour, minute, timeZone) {
      const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
      const firstOffset = ofsendOffsetMinutes(wallAsUtc, timeZone);
      let instant = wallAsUtc - firstOffset * 60000;
      const settledOffset = ofsendOffsetMinutes(instant, timeZone);
      if (settledOffset !== firstOffset) instant = wallAsUtc - settledOffset * 60000;
      return instant;
    }

    /** Whether an instant falls inside a Beijing peak window (end is exclusive). */
    function ofsendIsPeakAt(instant, rule) {
      const pricing = rule || PRICING;
      const parts = ofsendZonedParts(instant, pricing.timeZone);
      if (parts.weekday === 0 || parts.weekday === 6) return false;
      if (ofsendIsHoliday(parts, pricing)) return false;
      const minutes = parts.hour * 60 + parts.minute;
      for (let index = 0; index < pricing.peakWindows.length; index += 1) {
        const window = pricing.peakWindows[index];
        const start = window.startHour * 60 + window.startMinute;
        const end = window.endHour * 60 + window.endMinute;
        if (minutes >= start && minutes < end) return true;
      }
      return false;
    }

    /** Off-peak is the complement of peak: 50% of the peak token price. */
    function ofsendIsOffPeakAt(instant, rule) {
      return !ofsendIsPeakAt(instant, rule);
    }

    /** Beijing public-holiday list lookup (`holidays: ['2026-10-01', ...]`). */
    function ofsendIsHoliday(parts, rule) {
      const pricing = rule || PRICING;
      const holidays = pricing.holidays;
      if (!Array.isArray(holidays) || holidays.length === 0) return false;
      return holidays.indexOf(ofsendDateKey(parts)) !== -1;
    }

    /** End instant of the peak window that contains `instant`, or NaN. */
    function ofsendPeakWindowEnd(instant, rule) {
      const pricing = rule || PRICING;
      if (!ofsendIsPeakAt(instant, pricing)) return NaN;
      const parts = ofsendZonedParts(instant, pricing.timeZone);
      const minutes = parts.hour * 60 + parts.minute;
      for (let index = 0; index < pricing.peakWindows.length; index += 1) {
        const window = pricing.peakWindows[index];
        const start = window.startHour * 60 + window.startMinute;
        const end = window.endHour * 60 + window.endMinute;
        if (minutes >= start && minutes < end) {
          return ofsendWallToInstant(parts.year, parts.month, parts.day, window.endHour, window.endMinute, pricing.timeZone);
        }
      }
      return NaN;
    }

    /**
     * Next instant (strictly future) at which a peak window opens — i.e. when
     * the current off-peak stretch ends. Weekends and listed holidays are
     * skipped; NaN when no peak opens inside the search horizon.
     */
    function ofsendNextPeakStart(instant, rule) {
      const pricing = rule || PRICING;
      const parts = ofsendZonedParts(instant, pricing.timeZone);
      for (let offset = 0; offset < 15; offset += 1) {
        const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
        const dayParts = {
          year: day.getUTCFullYear(),
          month: day.getUTCMonth() + 1,
          day: day.getUTCDate(),
          weekday: day.getUTCDay(),
        };
        if (dayParts.weekday === 0 || dayParts.weekday === 6) continue;
        if (ofsendIsHoliday(dayParts, pricing)) continue;
        for (let index = 0; index < pricing.peakWindows.length; index += 1) {
          const window = pricing.peakWindows[index];
          const candidate = ofsendWallToInstant(dayParts.year, dayParts.month, dayParts.day, window.startHour, window.startMinute, pricing.timeZone);
          if (candidate - instant >= 1000) return candidate;
        }
      }
      return NaN;
    }

    /**
     * Target for the "off-peak" preset: right after the current peak window
     * ends (plus a safety margin against clock and dispatch jitter), or one
     * minute from now when the current instant is already off-peak.
     */
    function ofsendCheapPresetTarget(nowMs, rule) {
      const pricing = rule || PRICING;
      let candidate;
      if (ofsendIsPeakAt(nowMs, pricing)) {
        const end = ofsendPeakWindowEnd(nowMs, pricing);
        candidate = Number.isFinite(end) ? end + pricing.boundaryMarginMs : nowMs + MIN_LEAD_MS;
      } else {
        candidate = nowMs + MIN_LEAD_MS;
        if (ofsendIsPeakAt(candidate, pricing)) {
          const end = ofsendPeakWindowEnd(candidate, pricing);
          if (Number.isFinite(end)) candidate = end + pricing.boundaryMarginMs;
        }
      }
      return ofsendEnsureFuture(candidate, nowMs);
    }

    /** Never hand the Host a target that is already (almost) due. */
    function ofsendEnsureFuture(instant, nowMs) {
      return instant - nowMs >= 1000 ? instant : nowMs + MIN_LEAD_MS;
    }

    function ofsendPad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    /** Value for an `<input type="datetime-local">` in the browser's zone. */
    function ofsendLocalInputValue(instant) {
      const date = new Date(instant);
      return date.getFullYear() + '-' + ofsendPad2(date.getMonth() + 1) + '-' + ofsendPad2(date.getDate())
        + 'T' + ofsendPad2(date.getHours()) + ':' + ofsendPad2(date.getMinutes());
    }

    /** Parse an `<input type="datetime-local">` value as browser-local time. */
    function ofsendParseLocalInput(value) {
      if (typeof value !== 'string' || value === '') return NaN;
      const parsed = new Date(value);
      const time = parsed.getTime();
      return Number.isFinite(time) ? time : NaN;
    }

    /** Local-day-aware labels: today / tomorrow / calendar date + clock. */
    function ofsendFormatWhen(instant, nowMs) {
      const target = new Date(instant);
      const now = new Date(nowMs);
      const clock = ofsendPad2(target.getHours()) + ':' + ofsendPad2(target.getMinutes());
      const dateText = ofsendPad2(target.getMonth() + 1) + '-' + ofsendPad2(target.getDate());
      const full = target.getFullYear() + '-' + dateText + ' ' + clock;
      const sameDay = target.getFullYear() === now.getFullYear()
        && target.getMonth() === now.getMonth()
        && target.getDate() === now.getDate();
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const isTomorrow = target.getFullYear() === tomorrow.getFullYear()
        && target.getMonth() === tomorrow.getMonth()
        && target.getDate() === tomorrow.getDate();
      return {
        day: sameDay ? 'today' : isTomorrow ? 'tomorrow' : 'other',
        clock: clock,
        date: dateText,
        full: full,
      };
    }

    function ofsendDurationParts(durationMs) {
      const safeMs = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
      const totalMinutes = Math.max(0, Math.ceil(safeMs / 60000));
      return {
        days: Math.floor(totalMinutes / 1440),
        hours: Math.floor((totalMinutes % 1440) / 60),
        minutes: totalMinutes % 60,
        totalMinutes: totalMinutes,
      };
    }

    /** Durable task title: marker + localized prefix + one-line prompt snippet. */
    function ofsendTitle(prefix, prompt) {
      const normalized = String(prompt === undefined || prompt === null ? '' : prompt).replace(/\s+/g, ' ').trim();
      const head = TITLE_TAG + ' ' + (prefix ? String(prefix) + ' \u00b7 ' : '');
      const room = TITLE_MAX - head.length;
      let body = normalized;
      if (body.length > room) body = room > 1 ? body.slice(0, room - 1) + '\u2026' : '';
      return (head + body).slice(0, TITLE_MAX);
    }

    function ofsendIsOurs(record) {
      return record !== null
        && typeof record === 'object'
        && typeof record.title === 'string'
        && record.title.indexOf(TITLE_TAG) === 0;
    }

    /** Our active, one-shot, session-targeted tasks for one Session, soonest first. */
    function ofsendPendingFor(items, sessionId) {
      if (!Array.isArray(items) || typeof sessionId !== 'string' || sessionId === '') return [];
      const pending = [];
      for (let index = 0; index < items.length; index += 1) {
        const record = items[index];
        if (!record || record.status !== 'active' || !ofsendIsOurs(record)) continue;
        const target = record.target;
        if (!target || target.kind !== 'session' || target.sessionId !== sessionId) continue;
        pending.push(record);
      }
      pending.sort(function compareSoonest(left, right) {
        return Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt);
      });
      return pending;
    }

    /** Resolve the chosen preset to an epoch instant. */
    function ofsendPresetTarget(preset, customValue, nowMs, rule) {
      if (preset === 'plus1h') return nowMs + 3600000;
      if (preset === 'cheap') return ofsendCheapPresetTarget(nowMs, rule);
      return ofsendParseLocalInput(customValue);
    }

    /** Map a Remote failure envelope to a locale key. */
    function ofsendErrorKey(error) {
      if (error === null || typeof error !== 'object') return 'error.failed';
      const code = error.code;
      const details = error.details;
      const detailCode = details !== null && typeof details === 'object' ? details.code : undefined;
      if (code === 'schedule/input-invalid') {
        if (detailCode === 'not_future') return 'error.notFuture';
        if (detailCode === 'frequency_too_high') return 'error.frequency';
        if (detailCode === 'invalid_rule' || detailCode === 'invalid_time_zone' || detailCode === 'time_out_of_range') return 'error.invalidTime';
        if (detailCode === 'subagent_session') return 'error.subagent';
        return 'error.failed';
      }
      if (code === 'schedule/target-archived') return 'error.archived';
      return 'error.failed';
    }

    /* END PURE HELPERS */

    /* ------------------------------------------------------------------ *
     * Copy                                                               *
     * ------------------------------------------------------------------ */

    const zh = {
      'title.prefix': '定时发送',
      'button.tip': '定时发送：选一个时间，由 DSH 到点自动发出当前草稿（等谷价时段更省）',
      'button.aria': '定时发送',
      'popover.title': '定时发送',
      'popover.desc': '到点由 DSH 自动发出，页面关掉也会发。',
      'draft.label': '当前草稿',
      'draft.empty': '输入框还是空的：先写下要发的指令，再选时间。',
      'draft.attachments': '草稿带 {count} 个附件，定时发送暂不支持附件：请先移除附件，或直接发送。',
      'time.label': '发送时间',
      'preset.cheap': '谷价时段发送',
      'preset.cheapPeakHint': '等高峰结束 · {when}（约 {countdown} 后）',
      'preset.cheapNowHint': '当前已是谷价 · {when}（约 {countdown} 后）',
      'preset.plus1h': '1 小时后',
      'preset.plus1hHint': '{when} · {price}',
      'preset.custom': '自定义时间',
      'preset.customHint': '最早 {when}',
      'status.peak': '当前高峰，距谷价还有 {countdown}',
      'status.cheap': '当前谷价，距下一高峰还有 {countdown}',
      'tag.peak': '高峰·贵',
      'tag.cheap': '谷价·5 折',
      'hint.rule': '高峰：北京时间工作日 09:00–12:00、14:00–18:00；其余时间为谷价（= 高峰价 5 折）。',
      'hint.holidays': '周末全天谷价；法定节假日也按谷价，可在 client.js 顶部 holidays 维护节假日名单。',
      'action.close': '取消',
      'action.schedule': '定时发送',
      'action.scheduling': '安排中…',
      'error.empty': '草稿为空，先输入要发送的指令。',
      'error.future': '发送时间需要至少晚于现在 1 分钟。',
      'error.notFuture': '发送时间必须在未来，请重新选择。',
      'error.frequency': '两次投递间隔太近（至少 60 秒），请选晚一点。',
      'error.invalidTime': '这个时间在目标时区不可用，请换一个。',
      'error.archived': '当前会话已归档，无法定时发送。',
      'error.busy': '输入框正在发送中，稍后再试。',
      'error.failed': '创建定时任务失败，请重试。',
      'error.subagent': '当前是子代理会话，不能使用定时发送；请在主会话里使用。',
      'when.today': '今天 {clock}',
      'when.tomorrow': '明天 {clock}',
      'when.other': '{date} {clock}',
      'duration.dhm': '{days} 天 {hours} 小时',
      'duration.hm': '{hours} 小时 {minutes} 分',
      'duration.m': '{minutes} 分',
      'duration.lt1m': '不到 1 分钟',
      'strip.pending': '已定时发送 · {when}（{countdown}后）',
      'strip.more': '另有 {count} 条',
      'strip.cancel': '取消',
      'strip.confirm': '再点一次确认',
      'strip.canceling': '取消中…',
      'strip.cancelFailed': '取消失败：{message}',
      'strip.title': '定时发送任务（点取消可撤回）',
    };

    const en = {
      'title.prefix': 'Scheduled send',
      'button.tip': 'Schedule send: pick a time and the draft goes out automatically (wait for off-peak pricing to save tokens)',
      'button.aria': 'Schedule send',
      'popover.title': 'Schedule send',
      'popover.desc': 'DSH sends it automatically at the chosen time — even if this page is closed.',
      'draft.label': 'Current draft',
      'draft.empty': 'The composer is empty: write the instruction first, then pick a time.',
      'draft.attachments': 'The draft has {count} attachment(s); scheduled send does not support attachments yet. Remove them or send now.',
      'time.label': 'Send time',
      'preset.cheap': 'Off-peak send',
      'preset.cheapPeakHint': 'After the peak ends · {when} (in about {countdown})',
      'preset.cheapNowHint': 'Already off-peak · {when} (in about {countdown})',
      'preset.plus1h': 'In 1 hour',
      'preset.plus1hHint': '{when} · {price}',
      'preset.custom': 'Custom time',
      'preset.customHint': 'Earliest {when}',
      'status.peak': 'Peak now — off-peak starts in {countdown}',
      'status.cheap': 'Off-peak now — next peak starts in {countdown}',
      'tag.peak': 'Peak · full price',
      'tag.cheap': 'Off-peak · 50%',
      'hint.rule': 'Peak: Beijing weekdays 09:00–12:00 and 14:00–18:00; everything else is off-peak (= 50% of the peak price).',
      'hint.holidays': 'Weekends are off-peak all day; Chinese public holidays are off-peak too — list them under holidays at the top of client.js.',
      'action.close': 'Cancel',
      'action.schedule': 'Schedule send',
      'action.scheduling': 'Scheduling…',
      'error.empty': 'The draft is empty. Write the instruction first.',
      'error.future': 'The send time must be at least 1 minute from now.',
      'error.notFuture': 'The send time must be in the future. Pick another time.',
      'error.frequency': 'Two deliveries would be less than 60 seconds apart. Pick a later time.',
      'error.invalidTime': 'That time is not valid in the target time zone. Pick another time.',
      'error.archived': 'This conversation is archived, so scheduled send is unavailable.',
      'error.busy': 'The composer is sending right now. Try again in a moment.',
      'error.failed': 'Could not create the scheduled send. Try again.',
      'error.subagent': 'Delegated sub-sessions cannot schedule sends; use the main conversation.',
      'when.today': 'today {clock}',
      'when.tomorrow': 'tomorrow {clock}',
      'when.other': '{date} {clock}',
      'duration.dhm': '{days}d {hours}h',
      'duration.hm': '{hours}h {minutes}m',
      'duration.m': '{minutes}m',
      'duration.lt1m': 'under a minute',
      'strip.pending': 'Scheduled send · {when} (in {countdown})',
      'strip.more': '+{count} more',
      'strip.cancel': 'Cancel',
      'strip.confirm': 'Click again to confirm',
      'strip.canceling': 'Canceling…',
      'strip.cancelFailed': 'Cancel failed: {message}',
      'strip.title': 'Scheduled send task (cancel to withdraw)',
    };

    /* ------------------------------------------------------------------ *
     * Styles                                                             *
     * ------------------------------------------------------------------ */

    const STYLE_ID = 'dsh-offpeak-send';

    const CSS = `
.dsh-offpeak-anchor{display:inline-flex;align-items:center;position:relative}
.dsh-offpeak-trigger{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;transition:background .12s ease,color .12s ease}
.dsh-offpeak-trigger:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-offpeak-trigger[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.dsh-offpeak-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-offpeak-glyph{display:block;flex:none}
.dsh-offpeak-badge{position:absolute;top:-1px;right:-1px;min-width:14px;height:14px;padding:0 3px;box-sizing:border-box;border-radius:7px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-size:9px;font-weight:600;line-height:14px;text-align:center}
.dsh-offpeak-pop{position:fixed;z-index:2147000000;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 16px 40px color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);font-size:13px;line-height:1.45;overflow:auto;animation:dsh-offpeak-pop-in .14s ease-out}
.dsh-offpeak-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsh-offpeak-pop-title{font-weight:600;font-size:13px}
.dsh-offpeak-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;line-height:1;cursor:pointer}
.dsh-offpeak-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-offpeak-pop-desc{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.dsh-offpeak-draft-label,.dsh-offpeak-section{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-offpeak-draft{max-height:96px;overflow:auto;padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12.5px;white-space:pre-wrap;word-break:break-word}
.dsh-offpeak-draft-empty{color:var(--dsw-alias-label-secondary);font-style:italic}
.dsh-offpeak-options{display:flex;flex-direction:column;gap:4px}
.dsh-offpeak-option{display:flex;align-items:flex-start;gap:8px;padding:8px 9px;border:1px solid transparent;border-radius:9px;background:transparent;color:inherit;cursor:pointer}
.dsh-offpeak-option:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-offpeak-option-on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-offpeak-option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-offpeak-radio{flex:none;width:14px;height:14px;margin-top:2px;box-sizing:border-box;border:1.5px solid var(--dsw-alias-border-l2);border-radius:50%;background:transparent}
.dsh-offpeak-option-on .dsh-offpeak-radio{border-color:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 3px var(--dsw-alias-brand-primary)}
.dsh-offpeak-option-main{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-offpeak-option-label{font-size:13px}
.dsh-offpeak-option-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-offpeak-custom{display:flex}
.dsh-offpeak-input{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dsh-offpeak-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsh-offpeak-note{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-offpeak-status{font-size:11.5px;padding:5px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.dsh-offpeak-status-peak{color:var(--dsw-alias-state-warn-primary)}
.dsh-offpeak-status-cheap{color:var(--dsw-alias-state-success-primary)}
.dsh-offpeak-tag{flex:none;font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1)}
.dsh-offpeak-tag-peak{color:var(--dsw-alias-state-warn-primary)}
.dsh-offpeak-tag-cheap{color:var(--dsw-alias-state-success-primary)}
.dsh-offpeak-note-error{font-size:11.5px;color:var(--dsw-alias-state-error-primary)}
.dsh-offpeak-pop-foot{display:flex;align-items:center;gap:8px;margin-top:2px}
.dsh-offpeak-target{font-size:11.5px;font-weight:600;color:var(--dsw-alias-brand-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-offpeak-foot-spacer{flex:1}
.dsh-offpeak-btn{height:30px;padding:0 12px;border:1px solid transparent;border-radius:9px;cursor:pointer;font:inherit;font-size:12.5px;white-space:nowrap}
.dsh-offpeak-btn-ghost{background:transparent;border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dsh-offpeak-btn-ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-offpeak-btn-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.dsh-offpeak-btn-primary:disabled{opacity:.5;cursor:default}
.dsh-offpeak-dock{display:flex;justify-content:center;padding:6px 0 0;pointer-events:none}
.dsh-offpeak-dock-chip{pointer-events:auto;display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;max-width:min(560px,100%);padding:4px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 72%,transparent);color:var(--dsw-alias-label-secondary);font-size:11.5px}
.dsh-offpeak-dock-text{color:var(--dsw-alias-label-secondary)}
.dsh-offpeak-dock-more{opacity:.8}
.dsh-offpeak-dock-cancel{padding:0 4px;border:0;background:none;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11.5px;cursor:pointer}
.dsh-offpeak-dock-cancel:disabled{opacity:.5;cursor:default}
.dsh-offpeak-dock-error{color:var(--dsw-alias-state-error-primary)}
@keyframes dsh-offpeak-pop-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-reduced-motion:reduce){.dsh-offpeak-pop{animation:none}.dsh-offpeak-trigger{transition:none}}
`;

    function installStyles() {
      const previous = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]');
      if (previous !== null) previous.remove();
      const tag = document.createElement('style');
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return function removeStyles() {
        tag.remove();
      };
    }

    /* ------------------------------------------------------------------ *
     * Small helpers that need the translate seat                         *
     * ------------------------------------------------------------------ */

    function offsendWhenText(t, instant, nowMs) {
      const when = ofsendFormatWhen(instant, nowMs);
      if (when.day === 'today') return t('when.today', { clock: when.clock });
      if (when.day === 'tomorrow') return t('when.tomorrow', { clock: when.clock });
      return t('when.other', { date: when.date, clock: when.clock });
    }

    function offsendDurationText(t, durationMs) {
      const parts = ofsendDurationParts(durationMs);
      if (parts.totalMinutes < 1) return t('duration.lt1m');
      if (parts.days > 0) return t('duration.dhm', { days: parts.days, hours: parts.hours });
      if (parts.hours > 0) return t('duration.hm', { hours: parts.hours, minutes: parts.minutes });
      return t('duration.m', { minutes: parts.minutes });
    }

    /* ------------------------------------------------------------------ *
     * Schedule catalog feed                                              *
     * ------------------------------------------------------------------ */

    /**
     * One shared, ref-counted view of the Host schedule catalog. Both the
     * composer control and the ambient strip read it, so one Session issues one
     * query instead of one per surface.
     */
    function createOffsendFeed(ctx) {
      let snapshot = { status: 'idle', items: [], at: 0 };
      let inflight = null;
      let disposed = false;
      const listeners = new Set();

      function publish(next) {
        snapshot = next;
        for (const listener of Array.from(listeners)) {
          try {
            listener();
          } catch (error) {
            /* one broken subscriber must not starve the others */
          }
        }
      }

      function refresh() {
        if (inflight !== null) return inflight;
        inflight = (async function readCatalog() {
          try {
            const result = await ctx.remote.schedule.catalog();
            if (disposed) return;
            if (result !== null && typeof result === 'object' && result.ok === true) {
              publish({ status: 'ready', items: Array.isArray(result.value) ? result.value : [], at: Date.now() });
            } else {
              publish({ status: 'error', items: snapshot.items, at: Date.now() });
            }
          } catch (error) {
            if (!disposed) publish({ status: 'error', items: snapshot.items, at: Date.now() });
          } finally {
            inflight = null;
          }
        })();
        return inflight;
      }

      return {
        subscribe(listener) {
          listeners.add(listener);
          if (snapshot.status === 'idle') refresh();
          return function unsubscribe() {
            listeners.delete(listener);
          };
        },
        getSnapshot() {
          return snapshot;
        },
        refresh: refresh,
        dispose() {
          disposed = true;
          listeners.clear();
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * Glyph                                                              *
     * ------------------------------------------------------------------ */

    function OffsendClockGlyph(size) {
      const dimension = typeof size === 'number' ? size : 16;
      return h('svg', {
        className: 'dsh-offpeak-glyph',
        viewBox: '0 0 16 16',
        width: dimension,
        height: dimension,
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('circle', { cx: 8, cy: 8, r: 6.1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M8 4.7v3.6l2.5 1.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }

    /* ------------------------------------------------------------------ *
     * Composer control                                                   *
     * ------------------------------------------------------------------ */

    function OffsendSendControl(props) {
      const t = props.t;
      const feed = props.feed;
      const useRemoteAccess = props.useRemoteAccess;
      const useInput = props.useInput;
      const canCreate = typeof useRemoteAccess === 'function' ? useRemoteAccess('schedule/create') === true : false;
      const snapshot = useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
      const pending = useMemo(function selectPending() {
        return ofsendPendingFor(snapshot.items, props.sessionId);
      }, [snapshot.items, props.sessionId]);
      const draft = typeof useInput === 'function' ? useInput(function selectDraft(state) { return state.draft; }) : '';
      const phase = typeof useInput === 'function' ? useInput(function selectPhase(state) { return state.phase; }) : 'plain';
      const attachmentCount = typeof useInput === 'function'
        ? useInput(function selectAttachments(state) { return state.attachmentIds ? state.attachmentIds.length : 0; })
        : 0;
      const [open, setOpen] = useState(false);
      const anchorRef = useRef(null);
      const close = useCallback(function closePopover() {
        setOpen(false);
      }, []);
      const toggle = useCallback(function togglePopover() {
        setOpen(function next(current) { return !current; });
      }, []);

      if (!canCreate) return null;

      const trigger = h('button', {
        type: 'button',
        className: 'dsh-offpeak-trigger',
        'aria-label': t('button.aria'),
        'aria-haspopup': 'dialog',
        'aria-expanded': open ? 'true' : 'false',
        title: pending.length > 0 ? t('strip.pending', {
          when: offsendWhenText(t, Date.parse(pending[0].scheduledAt), Date.now()),
          countdown: offsendDurationText(t, Date.parse(pending[0].scheduledAt) - Date.now()),
        }) : t('button.tip'),
        onClick: toggle,
      },
        OffsendClockGlyph(16),
        pending.length > 0
          ? h('span', { className: 'dsh-offpeak-badge', 'aria-hidden': 'true' }, pending.length > 9 ? '9+' : String(pending.length))
          : null,
      );

      const popover = open ? h(OffsendPopover, {
        t: t,
        feed: feed,
        ops: props.ops,
        sessionId: props.sessionId,
        draft: draft,
        phase: phase,
        attachmentCount: attachmentCount,
        inputActions: props.inputActions,
        anchorRef: anchorRef,
        onClose: close,
      }) : null;

      return h('span', { className: 'dsh-offpeak-anchor', ref: anchorRef }, trigger, popover);
    }

    function OffsendPopover(props) {
      const t = props.t;
      const [now, setNow] = useState(function initialNow() { return Date.now(); });
      const [preset, setPreset] = useState('cheap');
      const [customValue, setCustomValue] = useState(function initialCustom() { return ofsendLocalInputValue(Date.now() + 2 * 3600000); });
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [position, setPosition] = useState(null);
      const popoverRef = useRef(null);

      const measure = useCallback(function measurePopover() {
        const anchor = props.anchorRef.current;
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        const viewportWidth = window.innerWidth || 1024;
        const viewportHeight = window.innerHeight || 768;
        const width = Math.min(320, Math.max(240, viewportWidth - 16));
        const left = Math.max(8, Math.min(rect.right - width, viewportWidth - width - 8));
        const bottom = Math.max(8, viewportHeight - rect.top + 8);
        const maxHeight = Math.max(200, Math.min(440, rect.top - 16));
        setPosition({ left: left, bottom: bottom, width: width, maxHeight: maxHeight });
      }, [props.anchorRef]);

      useEffect(function subscribeClock() {
        const timer = window.setInterval(function tick() {
          setNow(Date.now());
        }, 30000);
        return function stopClock() {
          window.clearInterval(timer);
        };
      }, []);

      useEffect(function placePopover() {
        measure();
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        return function removePlacement() {
          window.removeEventListener('resize', measure);
          window.removeEventListener('scroll', measure, true);
        };
      }, [measure]);

      useEffect(function dismissOnOutside() {
        function onPointerDown(event) {
          const target = event.target;
          if (!target || typeof target.nodeType !== 'number') return;
          const popover = popoverRef.current;
          const anchor = props.anchorRef.current;
          if (popover && popover.contains(target)) return;
          if (anchor && anchor.contains(target)) return;
          props.onClose();
        }
        function onKeyDown(event) {
          if (event.key === 'Escape') {
            event.stopPropagation();
            props.onClose();
          }
        }
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        return function removeDismiss() {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, [props.anchorRef, props.onClose]);

      const draftText = typeof props.draft === 'string' ? props.draft : '';
      const draftTrimmed = draftText.trim();
      const hasDraft = draftTrimmed !== '';
      const blocked = props.attachmentCount > 0;
      const peakNow = ofsendIsPeakAt(now, PRICING);
      const cheapTarget = ofsendCheapPresetTarget(now, PRICING);
      const plus1hTarget = now + 3600000;
      const target = preset === 'cheap' ? cheapTarget : preset === 'plus1h' ? plus1hTarget : ofsendParseLocalInput(customValue);
      const validTarget = Number.isFinite(target) && target - now >= MIN_LEAD_MS;
      const targetPeak = validTarget ? ofsendIsPeakAt(target, PRICING) : false;
      const nextPeakStart = ofsendNextPeakStart(now, PRICING);
      const peakStatusText = peakNow
        ? t('status.peak', { countdown: offsendDurationText(t, cheapTarget - now) })
        : t('status.cheap', { countdown: Number.isFinite(nextPeakStart) ? offsendDurationText(t, nextPeakStart - now) : t('duration.lt1m') });
      const earliest = now + MIN_LEAD_MS;

      function optionRow(key, label, hint) {
        const selected = preset === key;
        return h('div', {
          key: key,
          className: 'dsh-offpeak-option' + (selected ? ' dsh-offpeak-option-on' : ''),
          role: 'radio',
          'aria-checked': selected ? 'true' : 'false',
          tabIndex: 0,
          onClick: function choose() {
            setPreset(key);
            setError(null);
          },
          onKeyDown: function chooseByKeyboard(event) {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setPreset(key);
              setError(null);
            }
          },
        },
          h('span', { className: 'dsh-offpeak-radio', 'aria-hidden': 'true' }),
          h('span', { className: 'dsh-offpeak-option-main' },
            h('span', { className: 'dsh-offpeak-option-label' }, label),
            hint ? h('span', { className: 'dsh-offpeak-option-hint' }, hint) : null,
          ),
        );
      }

      async function submitSchedule() {
        setError(null);
        if (blocked) {
          setError(t('draft.attachments', { count: props.attachmentCount }));
          return;
        }
        if (!hasDraft) {
          setError(t('error.empty'));
          return;
        }
        if (typeof props.phase === 'string' && props.phase !== 'plain') {
          setError(t('error.busy'));
          return;
        }
        const nowMs = Date.now();
        const chosen = ofsendPresetTarget(preset, customValue, nowMs, PRICING);
        if (!Number.isFinite(chosen) || chosen - nowMs < MIN_LEAD_MS) {
          setError(t('error.future'));
          return;
        }
        setBusy(true);
        try {
          const result = await props.ops.create({
            title: ofsendTitle(t('title.prefix'), draftTrimmed),
            prompt: draftTrimmed,
            timing: { kind: 'at', at: new Date(chosen).toISOString() },
            target: { kind: 'session', sessionId: props.sessionId },
          });
          if (!result || result.ok !== true) {
            setError(t(ofsendErrorKey(result && result.error)));
            setBusy(false);
            return;
          }
          if ((typeof props.draft === 'string' ? props.draft : '').trim() === draftTrimmed) {
            try {
              props.inputActions.setDraft('');
            } catch (clearError) {
              /* the success path must survive a composer that just locked */
            }
          }
          props.feed.refresh();
          setBusy(false);
          props.onClose();
        } catch (submitError) {
          setError(t('error.failed'));
          setBusy(false);
        }
      }

      if (position === null) return null;

      const content = h('div', {
        className: 'dsh-offpeak-pop',
        role: 'dialog',
        'aria-label': t('popover.title'),
        ref: popoverRef,
        style: {
          left: position.left + 'px',
          bottom: position.bottom + 'px',
          width: position.width + 'px',
          maxHeight: position.maxHeight + 'px',
        },
        onMouseDown: function keepFocus(event) { event.stopPropagation(); },
      },
        h('div', { className: 'dsh-offpeak-pop-head' },
          h('span', { className: 'dsh-offpeak-pop-title' }, t('popover.title')),
          h('button', {
            type: 'button',
            className: 'dsh-offpeak-icon-btn',
            'aria-label': t('action.close'),
            onClick: props.onClose,
          }, h('span', { 'aria-hidden': 'true' }, '\u00d7')),
        ),
        h('div', { className: 'dsh-offpeak-pop-desc' }, t('popover.desc')),
        h('div', { className: 'dsh-offpeak-draft-label' }, t('draft.label')),
        h('div', { className: 'dsh-offpeak-draft' + (hasDraft ? '' : ' dsh-offpeak-draft-empty') }, hasDraft ? draftTrimmed : t('draft.empty')),
        blocked ? h('div', { className: 'dsh-offpeak-note-error', role: 'alert' }, t('draft.attachments', { count: props.attachmentCount })) : null,
        h('div', { className: 'dsh-offpeak-section' }, t('time.label')),
        h('div', {
          className: 'dsh-offpeak-status ' + (peakNow ? 'dsh-offpeak-status-peak' : 'dsh-offpeak-status-cheap'),
          role: 'status',
        }, peakStatusText),
        h('div', { className: 'dsh-offpeak-options', role: 'radiogroup', 'aria-label': t('time.label') },
          optionRow('cheap', t('preset.cheap'), peakNow
            ? t('preset.cheapPeakHint', {
              when: offsendWhenText(t, cheapTarget, now),
              countdown: offsendDurationText(t, cheapTarget - now),
            })
            : t('preset.cheapNowHint', {
              when: offsendWhenText(t, cheapTarget, now),
              countdown: offsendDurationText(t, cheapTarget - now),
            })),
          optionRow('plus1h', t('preset.plus1h'), t('preset.plus1hHint', {
            when: offsendWhenText(t, plus1hTarget, now),
            price: ofsendIsPeakAt(plus1hTarget, PRICING) ? t('tag.peak') : t('tag.cheap'),
          })),
          optionRow('custom', t('preset.custom'), t('preset.customHint', { when: offsendWhenText(t, earliest, now) })),
        ),
        preset === 'custom'
          ? h('div', { className: 'dsh-offpeak-custom' },
            h('input', {
              type: 'datetime-local',
              className: 'dsh-offpeak-input',
              value: customValue,
              min: ofsendLocalInputValue(earliest),
              'aria-label': t('preset.custom'),
              onChange: function changeCustom(event) {
                setPreset('custom');
                setCustomValue(event.target.value);
                setError(null);
              },
            }),
          )
          : null,
        h('div', { className: 'dsh-offpeak-note' }, t('hint.rule')),
        h('div', { className: 'dsh-offpeak-note' }, t('hint.holidays')),
        error !== null ? h('div', { className: 'dsh-offpeak-note-error', role: 'alert' }, error) : null,
        h('div', { className: 'dsh-offpeak-pop-foot' },
          h('span', { className: 'dsh-offpeak-target' }, validTarget
            ? offsendWhenText(t, target, now) + ' \u00b7 ' + offsendDurationText(t, target - now)
            : ''),
          validTarget
            ? h('span', { className: 'dsh-offpeak-tag ' + (targetPeak ? 'dsh-offpeak-tag-peak' : 'dsh-offpeak-tag-cheap') },
              targetPeak ? t('tag.peak') : t('tag.cheap'))
            : null,
          h('span', { className: 'dsh-offpeak-foot-spacer' }),
          h('button', {
            type: 'button',
            className: 'dsh-offpeak-btn dsh-offpeak-btn-ghost',
            onClick: props.onClose,
          }, t('action.close')),
          h('button', {
            type: 'button',
            className: 'dsh-offpeak-btn dsh-offpeak-btn-primary',
            disabled: busy || !hasDraft || blocked,
            onClick: submitSchedule,
          }, busy ? t('action.scheduling') : t('action.schedule')),
        ),
      );

      return ReactDOM !== null && typeof ReactDOM.createPortal === 'function'
        ? ReactDOM.createPortal(content, document.body)
        : content;
    }

    /* ------------------------------------------------------------------ *
     * Ambient pending strip under the composer card                      *
     * ------------------------------------------------------------------ */

    function OffsendPendingStrip(props) {
      const t = props.t;
      const feed = props.feed;
      const useRemoteAccess = props.useRemoteAccess;
      const canRead = typeof useRemoteAccess === 'function' ? useRemoteAccess('schedule/catalog') === true : false;
      const canCancel = typeof useRemoteAccess === 'function' ? useRemoteAccess('schedule/edit') === true : false;
      const snapshot = useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
      const pending = useMemo(function selectPending() {
        return ofsendPendingFor(snapshot.items, props.sessionId);
      }, [snapshot.items, props.sessionId]);
      const [now, setNow] = useState(function initialNow() { return Date.now(); });
      const [confirming, setConfirming] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);

      useEffect(function tickCountdown() {
        if (pending.length === 0) return undefined;
        const timer = window.setInterval(function tick() {
          setNow(Date.now());
        }, 15000);
        return function stopTick() {
          window.clearInterval(timer);
        };
      }, [pending.length]);

      useEffect(function expireConfirm() {
        if (!confirming) return undefined;
        const timer = window.setTimeout(function reset() {
          setConfirming(false);
        }, 4000);
        return function stopExpire() {
          window.clearTimeout(timer);
        };
      }, [confirming]);

      useEffect(function resetWhenEmpty() {
        if (pending.length === 0) {
          setError(null);
          setConfirming(false);
        }
      }, [pending.length]);

      if (!canRead || pending.length === 0) return null;

      const next = pending[0];
      const dueAt = Date.parse(next.scheduledAt);

      async function cancelNext() {
        if (!confirming) {
          setConfirming(true);
          return;
        }
        setBusy(true);
        try {
          const result = await props.ops.remove(next.id);
          if (!result || result.ok !== true) {
            setError(t('strip.cancelFailed', { message: t(ofsendErrorKey(result && result.error)) }));
          } else {
            setError(null);
            feed.refresh();
          }
        } catch (cancelError) {
          setError(t('strip.cancelFailed', { message: t('error.failed') }));
        }
        setBusy(false);
        setConfirming(false);
      }

      return h('div', { className: 'dsh-offpeak-dock' },
        h('div', { className: 'dsh-offpeak-dock-chip', title: typeof next.prompt === 'string' ? next.prompt : next.title },
          OffsendClockGlyph(13),
          h('span', { className: 'dsh-offpeak-dock-text' }, t('strip.pending', {
            when: offsendWhenText(t, dueAt, now),
            countdown: offsendDurationText(t, dueAt - now),
          })),
          pending.length > 1
            ? h('span', { className: 'dsh-offpeak-dock-more' }, t('strip.more', { count: pending.length - 1 }))
            : null,
          canCancel
            ? h('button', {
              type: 'button',
              className: 'dsh-offpeak-dock-cancel',
              disabled: busy,
              onClick: cancelNext,
            }, busy ? t('strip.canceling') : confirming ? t('strip.confirm') : t('strip.cancel'))
            : null,
          error !== null ? h('span', { className: 'dsh-offpeak-dock-error', role: 'alert' }, error) : null,
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Plugin wiring                                                      *
     * ------------------------------------------------------------------ */

    const inject = ['slots', 'locale', 'remote', 'remote.schedule', 'remoteAccess'];

    function apply(ctx) {
      ctx.effect(installStyles, 'dsh-offpeak-send: styles');
      ctx.effect(function registerDictionaries() {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, 'dsh-offpeak-send: dictionaries');

      const t = ctx.locale.bind(NS);
      const feed = createOffsendFeed(ctx);
      ctx.effect(function ownFeed() {
        return function disposeFeed() {
          feed.dispose();
        };
      }, 'dsh-offpeak-send: catalog feed');
      ctx.effect(function followScheduleChanges() {
        const stops = [];
        try {
          if (ctx.remote && typeof ctx.remote.$on === 'function') {
            stops.push(ctx.remote.$on('schedule/changed', function onScheduleChanged() {
              feed.refresh();
            }));
          }
        } catch (subscribeError) {
          /* the periodic/manual refresh path still works without the event */
        }
        return function stopFollowing() {
          for (const stop of stops) {
            try {
              stop();
            } catch (stopError) {
              /* ignore a listener already removed by the connection reset */
            }
          }
        };
      }, 'dsh-offpeak-send: schedule changes');

      const ops = {
        create: function createSchedule(request) {
          return ctx.remote.schedule.create(request);
        },
        remove: function removeSchedule(id) {
          return ctx.remote.schedule.edit({ id: id, action: 'delete' });
        },
      };

      ctx.slots.inject('conversation.input.right', function composerControl() {
        return ctx.slots.register({
          name: 'conversation.input.right',
          id: 'dsh-offpeak-send',
          order: 30,
          locale: NS,
          inject: function composerControlInject() {
            return { t: t, feed: feed, ops: ops };
          },
        }, OffsendSendControl);
      });

      ctx.slots.inject('conversation.composer.dock', function pendingStrip() {
        return ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-offpeak-send-pending',
          order: 30,
          locale: NS,
          inject: function pendingStripInject() {
            return { t: t, feed: feed, ops: ops };
          },
        }, OffsendPendingStrip);
      });
    }

    return { name: NS, inject: inject, apply: apply };
  },
});
