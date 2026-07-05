# Slot tracker

Pings me on Telegram when a new slot is published on the event page I'm
watching. Runs free on GitHub Actions, checks every 10 minutes. No browser.

## How it works

1. A scheduled Action runs `track.js` every 10 minutes.
2. It fetches the page (URL from the `EVENT_URL` secret) with `curl` — a plain
   request clears the site's waiting room, so no headless browser is needed —
   and reads the schedule embedded in the page as JSON.
3. It builds the set of session ids and diffs them against `state.json`. Any new
   id → a new slot → a Telegram message. Each slot alerts exactly once.
4. On a change it commits the new `state.json` back, so its commit history is a
   log of when each slot appeared.

If the page can't be read (site change, or the waiting room goes active), the
run **fails on purpose** so GitHub emails me — the watchdog, so silence never
looks like "nothing new".

## Secrets

Repo → Settings → Secrets and variables → Actions:

| Name                 | Value                        |
| -------------------- | ---------------------------- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token           |
| `TELEGRAM_CHAT_ID`   | my Telegram chat id          |
| `EVENT_URL`          | the event page URL to watch  |

## Run / tweak

- **Manual run:** Actions tab → this workflow → **Run workflow**.
- **Cadence:** edit the `cron` in `.github/workflows/track.yml`.
- **Pause:** Actions tab → **⋯ → Disable workflow**.
- **Local test:** `EVENT_URL=… TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… node track.js`
  (needs Node 18+ and `curl`; without the Telegram vars it prints what it would send).

## Files

| File                              | Purpose                                   |
| --------------------------------- | ----------------------------------------- |
| `track.js`                        | fetch → parse → diff → Telegram (no deps) |
| `.github/workflows/track.yml`     | the 10-minute scheduled check             |
| `.github/workflows/keepalive.yml` | monthly no-op so the schedule can't idle out |
| `state.json`                      | last-seen slots (created on first run)    |
