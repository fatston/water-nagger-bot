# Water Reminder Telegram Bot

A small Telegram bot that asks each user how often they want water reminders, tracks messages like `I drank 250ml`, and sends an end-of-day total.

## Features

- First-run setup with reminder choices: every 1h, 2h, 3h, or 6h.
- End-of-day summary choices: 10pm, midnight, or a custom time.
- Intake tracking from natural messages like:
  - `I drank 250ml`
  - `500 ml`
  - `drank 0.5L`
  - `/drink 750`
- Persistent Telegram buttons for:
  - `Drank 250ml`
  - `Drank 500ml`
  - `Drank custom`
  - `How am I doing?`
- Reminder check-ins:
  - If you drank within your chosen interval, it reports how much you drank over that interval.
  - If you have not, it nudges you to drink water.
  - Reminder check-ins only run from 9am until midnight.
- Daily total sent at your chosen end-of-day time, with a different message based on how much you drank.
- Good morning hydration message every day at 9am.
- Local JSON persistence, no database server needed.

## Setup

1. Create a bot with [BotFather](https://t.me/BotFather) and copy the token.
2. Copy `.env.example` to `.env`.
3. Put your token in `.env`:

   ```env
   TELEGRAM_BOT_TOKEN=123456:replace-me
   ```

4. Start the bot:

   ```bash
   npm start
   ```

   If your local `npm` is noisy or unavailable, run the bot directly:

   ```bash
   node src/bot.js
   ```

## Commands

- `/start` - run setup.
- `/help` - show command help.
- `/drink 250` - log 250ml.
- `/today` - show today's total.
- `/summary` - show today's total.
- `/settings` - show current settings and setup buttons.
- `/interval 2h` - set reminder interval. Also supports `90m`.
- `/end 22:30` - set end-of-day summary time.
- `reset` - ask for confirmation, then clear your settings and restart setup.

You can also tap `Drank custom`, then reply with a number such as `360` to log 360ml.

Tap `How am I doing?` to see today's total and how much more is needed to reach the daily target. The default target is 2000ml.

## Environment

- `TELEGRAM_BOT_TOKEN` is required.
- `BOT_TIMEZONE` defaults to `Asia/Singapore`.
- `DATA_FILE` defaults to `./data/water-bot.json`.
- `DAILY_WATER_TARGET_ML` defaults to `2000`.
- `POLL_TIMEOUT_SECONDS` defaults to `25`.
- `SCHEDULER_TICK_SECONDS` defaults to `30`.

Keep the process running on a server, terminal, or process manager such as PM2 for continuous reminders.
