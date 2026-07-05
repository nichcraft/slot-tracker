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
const HEARTBEAT = process.env.HEARTBEAT === '1';
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

// Persists slots, stamping each with `firstSeen`. A game that already existed
// keeps its original stamp; a genuinely new game (absent from prev) is stamped
// now. On the first-run seed there is no prev, so everything is baselined to the
// epoch (i.e. "old") — only games that appear AFTER we start watching count as
// new. Legacy records without a stamp are baselined to the epoch too.
const EPOCH = '1970-01-01T00:00:00.000Z';

function saveState(slots, prev) {
  const prevSlots = (prev && prev.slots) || {};
  const isSeed = !prev;
  const now = new Date().toISOString();
  const out = {};
  for (const s of slots) {
    const existing = prevSlots[s.id];
    let firstSeen;
    if (existing) firstSeen = existing.firstSeen || EPOCH;
    else firstSeen = isSeed ? EPOCH : now;
    out[s.id] = { ...s, firstSeen };
  }
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ updatedAt: now, count: slots.length, slots: out }, null, 2) + '\n'
  );
}

// --- notify -------------------------------------------------------------

function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-07-06" -> "Mon 6 Jul" (parsed as a plain date, no timezone shift)
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const y = +m[1];
  const mo = +m[2] - 1;
  const d = +m[3];
  const wd = new Date(Date.UTC(y, mo, d)).getUTCDay();
  return `${WEEKDAYS[wd]} ${d} ${MONTHS[mo]}`;
}

// Group slots by date (chronological), each under a bold weekday header.
// If isNew(s) returns true, the game is prefixed with 🆕 instead of a bullet.
function fmtGroupedSlots(slots, isNew) {
  const byDate = new Map();
  for (const s of slots) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  }
  const groups = [];
  for (const date of [...byDate.keys()].sort()) {
    const lines = [`<b>${fmtDate(date)}</b>`];
    const day = byDate.get(date).sort((a, b) => a.time.localeCompare(b.time));
    for (const s of day) {
      const when = s.endTime ? `${s.time}–${s.endTime}` : s.time;
      const sold = s.soldOut ? ' · sold out' : '';
      const mark = isNew && isNew(s) ? '🆕 ' : '• ';
      lines.push(`${mark}${withFlags(s.game)}`); // teams on their own line
      lines.push(`   ${when}${sold}`); // time / status on the next line
    }
    groups.push(lines.join('\n'));
  }
  return groups.join('\n\n'); // blank line between dates
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
    if (HEARTBEAT) await sendTelegram("⚠️ <b>Tracker heartbeat</b>\nCouldn't read the page right now — it will keep retrying on the 10-minute schedule.");
    console.error('FATAL: could not fetch the page after retries.');
    process.exit(1); // watchdog
  }

  const data = parseAppData(html);
  if (!data) {
    if (HEARTBEAT) await sendTelegram("⚠️ <b>Tracker heartbeat</b>\nRead the page but couldn't parse the schedule — it may have changed. Worth a look.");
    console.error('FATAL: page fetched but schedule data missing/unparseable (queue page or site change?).');
    process.exit(1); // watchdog
  }

  const slots = collectSlots(data);
  console.log(
    `read ${slots.length} slot(s): ` +
      slots.map((s) => `${s.date} ${s.time} ${s.game}`).join(' | ')
  );

  const prev = loadState();
  const bookingLink = `\n\n🎟 <a href="${EVENT_URL}">Open booking page</a>`;
  const plural = (n) => (n === 1 ? '' : 's');

  // Heartbeat mode: confirm the live pipeline works and report what's on,
  // flagging games added in the last day. No diffing, no state changes.
  if (HEARTBEAT) {
    const seen = (prev && prev.slots) || {};
    const now = Date.now();
    const isNew = (s) => {
      const rec = seen[s.id];
      if (!rec) return true; // live but not yet recorded -> new
      if (!rec.firstSeen) return false; // legacy record, no stamp -> treat as old
      return now - Date.parse(rec.firstSeen) < 24 * 3600 * 1000;
    };
    const newCount = slots.filter(isNew).length;
    const list = slots.length ? fmtGroupedSlots(slots, isNew) : '(nothing listed right now)';
    const ok = await sendTelegram(
      `☀️ <b>Morning check</b> · watching ${slots.length} game${plural(slots.length)}` +
        `${newCount ? ` (${newCount} new)` : ''}\n\n${list}${bookingLink}`
    );
    if (!ok) process.exit(1);
    console.log('heartbeat sent');
    return;
  }

  // First run: seed silently (baseline) and send a one-time "is live" summary.
  if (!prev) {
    saveState(slots, null);
    const list = slots.length ? fmtGroupedSlots(slots) : '(nothing listed right now)';
    await sendTelegram(
      `🎬 <b>Tracker is live</b>\n` +
        `Watching ${slots.length} game${plural(slots.length)}. I'll ping you when a new one is published.\n\n${list}`
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

  const header = `🆕 <b>${newSlots.length} new game${plural(newSlots.length)} published</b>`;
  const body = fmtGroupedSlots(newSlots);

  const ok = await sendTelegram(`${header}\n\n${body}${bookingLink}`);
  if (!ok) {
    console.error('FATAL: Telegram send failed; leaving state unchanged so it retries next run.');
    process.exit(1); // watchdog + don't persist so we re-alert next run
  }

  saveState(slots, prev);
  console.log(`alerted ${newSlots.length} new game(s) and updated state.json`);
})().catch((e) => {
  console.error('unexpected error ->', e && e.stack ? e.stack : e);
  process.exit(1);
});
