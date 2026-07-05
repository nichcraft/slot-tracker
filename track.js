#!/usr/bin/env node
/**
 * Slot tracker.
 *
 * Fetches the event page (URL comes from the EVENT_URL env var so it never
 * lives in source), reads the schedule embedded in the page, and alerts on
 * Telegram whenever a NEW slot appears.
 *
 * Detection = set difference on the stable session id vs. the last committed
 * snapshot in state.json. Each new slot alerts exactly once.
 *
 * Fetch uses curl with `-b ""` so the site's waiting-room pass-through cookie
 * is retained across the redirect chain — no headless browser needed.
 *
 * Exit codes:
 *   0  = ran fine (whether or not there were new slots)
 *   1  = could not read/parse the page after retries, OR a Telegram send failed.
 *        On CI this fails the run so you get an email — the watchdog, so silence
 *        never gets mistaken for "nothing new".
 *
 * No npm dependencies. Requires: curl on PATH, Node 18+ (global fetch).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EVENT_URL = process.env.EVENT_URL;
const STATE_FILE = path.join(__dirname, 'state.json');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fetch --------------------------------------------------------------

// One curl attempt. `-b ""` turns on curl's cookie jar so the waiting-room
// acceptance cookie is retained across the 302 chain (without it curl loops).
function curlOnce() {
  const raw = execFileSync(
    'curl',
    [
      '-sL',
      '-b', '',
      '--max-redirs', '20',
      '--connect-timeout', '20',
      '--max-time', '60',
      '-A', UA,
      '-w', '\n__STATUS__=%{http_code}',
      EVENT_URL,
    ],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
  const m = raw.match(/\n__STATUS__=(\d+)\s*$/);
  const status = m ? m[1] : '000';
  const html = raw.replace(/\n__STATUS__=\d+\s*$/, '');
  return { status, html };
}

async function fetchPage(attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const { status, html } = curlOnce();
      if (html.includes('showByDateMap')) {
        console.log(`fetch ok (HTTP ${status}, ${html.length} bytes) on attempt ${i}`);
        return html;
      }
      console.error(`attempt ${i}: HTTP ${status}, ${html.length} bytes, schedule data not present`);
      if (/queue-it|queue\./i.test(html)) {
        console.error('  -> response looks like a waiting-room page (queue may be active)');
      }
    } catch (e) {
      console.error(`attempt ${i}: curl failed -> ${e.message}`);
    }
    if (i < attempts) await sleep(5000 * i);
  }
  return null;
}

// --- parse --------------------------------------------------------------

function htmlDecode(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // must be last
}

// Locate the embedded schedule JSON generically (any data-*="..." attribute
// whose value contains showByDateMap), decode entities, and parse it.
function parseAppData(html) {
  const re = /data-[\w-]+="([^"]*showByDateMap[^"]*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const obj = JSON.parse(htmlDecode(m[1]));
      if (obj && obj.showByDateMap) return obj;
    } catch (_) {
      /* try the next candidate */
    }
  }
  return null;
}

// Flatten showByDateMap into slot records keyed by session id.
function collectSlots(data) {
  const map = (data && data.showByDateMap) || {};
  const slots = [];
  for (const date of Object.keys(map)) {
    const arr = Array.isArray(map[date]) ? map[date] : [];
    for (const s of arr) {
      if (s.idEventSession == null) continue;
      slots.push({
        id: String(s.idEventSession),
        idShow: s.idEventShow != null ? String(s.idEventShow) : null,
        date,
        time: s.time || s.timeRange || '',
        endTime: s.endTime || '',
        game: (s.distinctiveFeatures || '').trim() || '(no title)',
        soldOut: !!s.isSoldOut,
      });
    }
  }
  return slots;
}

// --- flags --------------------------------------------------------------

// name -> ISO 3166 alpha-2 (flag is generated from the code)
const COUNTRY_CODE = {
  afghanistan: 'af', albania: 'al', algeria: 'dz', angola: 'ao', argentina: 'ar',
  australia: 'au', austria: 'at', bahrain: 'bh', belgium: 'be', bolivia: 'bo',
  'bosnia and herzegovina': 'ba', brazil: 'br', bulgaria: 'bg', cameroon: 'cm',
  canada: 'ca', 'cape verde': 'cv', chile: 'cl', china: 'cn', colombia: 'co',
  'costa rica': 'cr', croatia: 'hr', 'czech republic': 'cz', czechia: 'cz',
  denmark: 'dk', ecuador: 'ec', egypt: 'eg', 'el salvador': 'sv', finland: 'fi',
  france: 'fr', germany: 'de', ghana: 'gh', greece: 'gr', guatemala: 'gt',
  honduras: 'hn', hungary: 'hu', iceland: 'is', india: 'in', indonesia: 'id',
  iran: 'ir', iraq: 'iq', ireland: 'ie', 'republic of ireland': 'ie', israel: 'il',
  italy: 'it', 'ivory coast': 'ci', "cote d'ivoire": 'ci', jamaica: 'jm', japan: 'jp',
  jordan: 'jo', kenya: 'ke', kuwait: 'kw', 'saudi arabia': 'sa', 'south korea': 'kr',
  'korea republic': 'kr', korea: 'kr', 'north korea': 'kp', lebanon: 'lb', libya: 'ly',
  luxembourg: 'lu', malaysia: 'my', mali: 'ml', mexico: 'mx', montenegro: 'me',
  morocco: 'ma', netherlands: 'nl', 'new zealand': 'nz', nigeria: 'ng', norway: 'no',
  oman: 'om', pakistan: 'pk', panama: 'pa', paraguay: 'py', peru: 'pe', poland: 'pl',
  portugal: 'pt', qatar: 'qa', romania: 'ro', russia: 'ru', senegal: 'sn',
  serbia: 'rs', singapore: 'sg', slovakia: 'sk', slovenia: 'si', 'south africa': 'za',
  spain: 'es', sweden: 'se', switzerland: 'ch', syria: 'sy', thailand: 'th',
  tunisia: 'tn', turkey: 'tr', turkiye: 'tr', uae: 'ae', 'united arab emirates': 'ae',
  ukraine: 'ua', uruguay: 'uy', usa: 'us', us: 'us', 'united states': 'us',
  'united states of america': 'us', uzbekistan: 'uz', venezuela: 've', vietnam: 'vn',
};

// Home nations have no ISO code; use the subdivision tag-flag emoji.
const SPECIAL_FLAGS = {
  england: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
  scotland: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
  wales: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}',
};

function normCountry(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/\.$/, '')
    .replace(/[‘’′`]/g, "'")
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

function iso2flag(cc) {
  return [...cc.toUpperCase()]
    .map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65))
    .join('');
}

function flagFor(name) {
  const k = normCountry(name);
  if (SPECIAL_FLAGS[k]) return SPECIAL_FLAGS[k];
  const cc = COUNTRY_CODE[k];
  return cc ? iso2flag(cc) : '';
}

// "Brazil vs. Norway" -> "Brazil 🇧🇷 vs Norway 🇳🇴" (HTML-escaped, flags appended)
function withFlags(game) {
  const parts = String(game).split(/\s+vs?\.?\s+/i);
  if (parts.length < 2) return esc(game);
  const decorate = (t) => {
    const clean = t.trim();
    const f = flagFor(clean);
    return esc(clean) + (f ? ' ' + f : '');
  };
  return `${decorate(parts[0])} vs ${decorate(parts.slice(1).join(' vs '))}`;
}

// --- state --------------------------------------------------------------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(slots) {
  const obj = {
    updatedAt: new Date().toISOString(),
    count: slots.length,
    slots: Object.fromEntries(slots.map((s) => [s.id, s])),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2) + '\n');
}

// --- notify -------------------------------------------------------------

function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtSlot(s) {
  const when = s.endTime ? `${s.time}–${s.endTime}` : s.time;
  const sold = s.soldOut ? ' · SOLD OUT' : '';
  return `<b>${withFlags(s.game)}</b>\n   ${s.date} · ${when}${sold}`;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.error('Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing) — message not sent:');
    console.error(text.replace(/<[^>]+>/g, ''));
    return false;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!resp.ok) {
      console.error('Telegram API error', resp.status, await resp.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('Telegram request failed ->', e.message);
    return false;
  }
}

// --- main ---------------------------------------------------------------

(async () => {
  if (!EVENT_URL) {
    console.error('FATAL: EVENT_URL is not set.');
    process.exit(1);
  }

  const html = await fetchPage();
  if (!html) {
    console.error('FATAL: could not fetch the page after retries.');
    process.exit(1); // watchdog
  }

  const data = parseAppData(html);
  if (!data) {
    console.error('FATAL: page fetched but schedule data missing/unparseable (queue page or site change?).');
    process.exit(1); // watchdog
  }

  const slots = collectSlots(data);
  console.log(
    `read ${slots.length} slot(s): ` +
      slots.map((s) => `${s.date} ${s.time} ${s.game}`).join(' | ')
  );

  const prev = loadState();

  // First run: seed silently and send a one-time "is live" summary.
  if (!prev) {
    saveState(slots);
    const summary = slots.length ? slots.map(fmtSlot).join('\n') : '(nothing listed right now)';
    await sendTelegram(
      `🎬 <b>Tracker is live</b>\n` +
        `Watching ${slots.length} slot(s). I'll ping you when a new one is published.\n\n${summary}`
    );
    console.log('seeded initial state.json');
    return;
  }

  const prevIds = new Set(Object.keys(prev.slots || {}));
  const newSlots = slots.filter((s) => !prevIds.has(s.id));

  if (newSlots.length === 0) {
    console.log('nothing new.');
    return; // no state write -> no commit
  }

  newSlots.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const header = `🚨 <b>${newSlots.length} new slot${newSlots.length > 1 ? 's' : ''} just published!</b>`;
  const body = newSlots.map(fmtSlot).join('\n');
  const link = `\n\n🎟️ <a href="${EVENT_URL}">Open booking page</a>`;

  const ok = await sendTelegram(`${header}\n\n${body}${link}`);
  if (!ok) {
    console.error('FATAL: Telegram send failed; leaving state unchanged so it retries next run.');
    process.exit(1); // watchdog + don't persist so we re-alert next run
  }

  saveState(slots);
  console.log(`alerted ${newSlots.length} new slot(s) and updated state.json`);
})().catch((e) => {
  console.error('unexpected error ->', e && e.stack ? e.stack : e);
  process.exit(1);
});
