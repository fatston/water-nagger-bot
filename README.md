# Water Reminder Telegram Bot

A small Telegram bot that reminds users to drink water, tracks messages like `I drank 250ml`, and summarizes progress over the day, week, month, and lifetime.

## Features

- First-run setup with a default 3-hour reminder interval.
- Custom reminder intervals from 15 to 360 minutes with `/interval 60`.
- End-of-day summary choices: 10pm, midnight, or a custom time.
- SQLite lifetime consumption tracking.
- Intake tracking from natural messages like:
  - `I drank 250ml`
  - `500 ml`
  - `drank 0.5L`
  - `/drink 750`
- Persistent Telegram buttons for:
  - `Drank 250ml`
  - `Drank 500ml`
  - `/status`
  - `/help`
- Reminder check-ins:
  - Reports today's total, remaining amount, and a compact progress bar.
  - Reminder check-ins only run from 9am until the configured end-of-day time.
- `/shutup` pauses reminders until the next day without clearing today's intake.
- `/starttalking` resumes reminders after `/shutup`.
- Daily total sent at your chosen end-of-day time, with a different message based on how much you drank.
- Weekly progress sent automatically every Sunday at 10:00 in the configured bot timezone.
- Good morning hydration message every day at 9am.
- Local JSON settings plus SQLite consumption persistence, no database server needed.

## Setup

1. Create a bot with [BotFather](https://t.me/BotFather) and copy the token.
2. Copy `.env.example` to `.env`.
3. Put your token in `.env`:

   ```env
   TELEGRAM_BOT_TOKEN=123456:replace-me
   ```

4. Start the bot:

   ```bash
   npm install
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
- `/status` - show progress toward the daily target.
- `/weekprogress` - show this week's progress.
- `/monthprogress` - show this month's progress.
- `/lifetimeprogress` - show all-time logged water.
- `/today` - show today's total.
- `/summary` - show today's total.
- `/reset` - reset today's water tracking.
- `/resetall` - reset setup and delete all saved progress after confirmation.
- `/settings` - show current settings and setup buttons.
- `/interval 60` - set reminder interval in minutes. Values must be from 15 to 360.
- `/end 22:30` - set end-of-day summary time.
- `/shutup` - pause reminders until tomorrow.
- `/starttalking` - resume reminders.

You can also send a number such as `360` or a message like `I drank 500ml`.

Tap `/status` to see today's total and how much more is needed to reach the daily target. The default target is 2000ml.

## Testing

Run the deterministic local tests without Telegram API calls:

```bash
npm test
```

## Environment

- `TELEGRAM_BOT_TOKEN` is required.
- `BOT_TIMEZONE` defaults to `Asia/Singapore`.
- `DATA_FILE` defaults to `./data/water-bot.json`.
- `SQLITE_DB_FILE` defaults to `./data/water-bot.sqlite`.
- `DAILY_WATER_TARGET_ML` defaults to `2000`.
- `DEFAULT_REMINDER_INTERVAL_MINUTES` defaults to `180`.
- `POLL_TIMEOUT_SECONDS` defaults to `25`.
- `SCHEDULER_TICK_SECONDS` defaults to `30`.

Keep the process running on a server, terminal, or process manager such as PM2 for continuous reminders.
