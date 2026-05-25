"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

loadDotEnv(path.resolve(process.cwd(), ".env"));

const token = process.env.TELEGRAM_BOT_TOKEN;
const timezone = process.env.BOT_TIMEZONE || "Asia/Singapore";
const dataFile = path.resolve(process.cwd(), process.env.DATA_FILE || "./data/water-bot.json");
const sqliteFile = path.resolve(process.cwd(), process.env.SQLITE_DB_FILE || "./data/water-bot.sqlite");
const pollTimeoutSeconds = parseInt(process.env.POLL_TIMEOUT_SECONDS || "25", 10);
const schedulerTickMs = parseInt(process.env.SCHEDULER_TICK_SECONDS || "30", 10) * 1000;
const dailyWaterTargetMl = parseInt(process.env.DAILY_WATER_TARGET_ML || "2000", 10);
const defaultIntervalMinutes = parseInt(process.env.DEFAULT_REMINDER_INTERVAL_MINUTES || "180", 10);
const reminderStartMinute = 9 * 60;
const reminderEndMinute = 24 * 60;
const shouldStart = require.main === module;

if (!token && shouldStart) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and add your BotFather token.");
  process.exit(1);
}

const apiBase = "https://api.telegram.org/bot" + token;
let store = createStore(dataFile);
let lifetimeStore = createLifetimeStore(sqliteFile);
let apiRequest = api;
let nowProvider = function () {
  return new Date();
};
let updateOffset = store.data.meta.updateOffset || 0;

const intervalOptions = [
  { label: "Every 1h", minutes: 60 },
  { label: "Every 2h", minutes: 120 },
  { label: "Every 3h", minutes: 180 },
  { label: "Every 6h", minutes: 360 }
];

const minIntervalMinutes = 15;
const maxIntervalMinutes = 6 * 60;

const endTimeOptions = [
  { label: "10pm", value: "22:00" },
  { label: "12 midnight", value: "00:00" }
];

const morningMessages = [
  "Good morning ☀️ Your brain is about 75% water, so even mild dehydration can affect focus and alertness. Time for some water 💧",
  "Morning! Staying hydrated supports energy, concentration, and overall health. Start the day with a glass of water 😊",
  "Hydration plays a role in concentration, mood, and physical performance more than most people realize 💙",
  "Small daily habits matter over the long run — including drinking enough water 🌱",
  "Even mild dehydration can leave you feeling tired or sluggish. Good morning — hydrate first 🚰",
  "Water supports circulation, digestion, and temperature regulation — your body uses it for almost everything 💧",
  "Good morning ☀️ Think of water as basic maintenance for the body and brain.",
  "A well-hydrated body generally feels and functions better. Simple habit, worthwhile payoff 🌊",
  "Your body constantly loses water throughout the day, so regular hydration actually matters more than people think 💙",
  "Good morning! Staying hydrated is one of those simple habits that quietly helps over time 💧"
];

if (shouldStart) start();

function start() {
  console.log("Water reminder bot started.");
  console.log("Timezone:", timezone);
  console.log("Data file:", dataFile);
  console.log("SQLite file:", sqliteFile);

  setInterval(runScheduler, schedulerTickMs);
  runScheduler();
  pollLoop();
}

async function pollLoop() {
  while (true) {
    try {
      const result = await apiRequest("getUpdates", {
        offset: updateOffset,
        timeout: pollTimeoutSeconds,
        allowed_updates: ["message", "callback_query"]
      });

      for (const update of result) {
        updateOffset = update.update_id + 1;
        store.data.meta.updateOffset = updateOffset;
        store.save();
        await handleUpdate(update);
      }
    } catch (error) {
      console.error("Polling error:", error.message);
      await sleep(3000);
    }
  }
}

async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  if (!update.message || !update.message.chat) return;

  const chatId = String(update.message.chat.id);
  const text = (update.message.text || "").trim();
  const user = ensureUser(chatId, update.message.from);

  if (!text) return;

  if (text === "/reset" || text.toLowerCase() === "reset") {
    user.setupStep = "confirm_reset";
    store.save();
    await sendMessage(
      chatId,
      "Reset your water bot setup? This will clear your settings and today's logged water. You will need to set up reminders again.",
      resetConfirmKeyboard()
    );
    return;
  }

  if (text.toLowerCase() === "drank custom") {
    user.setupStep = "custom_drink_amount";
    store.save();
    await sendMessage(chatId, "How many ml did you drink? Send a number like `360`.");
    return;
  }

  if (text === "/status" || text.toLowerCase() === "how am i doing?") {
    await sendStatus(chatId, user);
    return;
  }

  if (user.setupStep === "custom_drink_amount" && text.charAt(0) !== "/") {
    const amount = parseWaterAmount(text);
    if (!amount) {
      await sendMessage(chatId, "Please send the amount in ml, like `360`.");
      return;
    }
    user.setupStep = null;
    await recordDrink(chatId, user, amount);
    return;
  }

  if (text === "/start") {
    user.intervalMinutes = defaultIntervalMinutes;
    user.setupStep = "end_time";
    user.startedAt = nowProvider().toISOString();
    store.save();
    await sendWelcome(chatId);
    return;
  }

  if (text === "/help") {
    await sendHelp(chatId);
    return;
  }

  if (text === "/settings") {
    await sendSettings(chatId, user);
    return;
  }

  if (text === "/shutup" || text === "/shut-up") {
    user.pausedUntilDate = nextLocalDateKey(nowProvider());
    store.save();
    await sendMessage(chatId, "Paused for today. I will check in again tomorrow.");
    return;
  }

  if (text === "/today" || text === "/summary") {
    await sendTodaySummary(chatId, user);
    return;
  }

  if (text === "/weekprogress" || text === "/week-progress") {
    await sendRangeProgress(chatId, "week");
    return;
  }

  if (text === "/monthprogress" || text === "/month-progress") {
    await sendRangeProgress(chatId, "month");
    return;
  }

  if (text === "/lifetimeprogress" || text === "/lifetime-progress") {
    await sendLifetimeProgress(chatId);
    return;
  }

  if (text.indexOf("/drink") === 0) {
    const amount = parseWaterAmount(text.replace("/drink", ""));
    if (!amount) {
      await sendMessage(chatId, "Tell me the amount like `/drink 250` or `/drink 0.5L`.");
      return;
    }
    await recordDrink(chatId, user, amount);
    return;
  }

  if (text.indexOf("/interval") === 0) {
    const minutes = parseIntervalMinutes(text.replace("/interval", ""));
    if (!minutes) {
      await sendMessage(chatId, "Use `/interval 60` to set reminders every 60 minutes.");
      return;
    }
    if (!isValidInterval(minutes)) {
      await sendMessage(chatId, "Please choose an interval from 15 to 360 minutes.");
      return;
    }
    setIntervalMinutes(user, minutes);
    await sendMessage(chatId, "Done. I will check in every " + minutes + " minutes.");
    return;
  }

  if (text.indexOf("/end") === 0) {
    const endTime = parseTime(text.replace("/end", ""));
    if (!endTime) {
      await sendMessage(chatId, "Use `/end 22:00` for 10pm or `/end 00:00` for midnight.");
      return;
    }
    user.endOfDayTime = endTime;
    user.setupStep = null;
    store.save();
    await sendMessage(chatId, "Daily summary time set to " + endTime + ".");
    return;
  }

  if (user.setupStep === "custom_end_time") {
    const endTime = parseTime(text);
    if (!endTime) {
      await sendMessage(chatId, "Please send the time as `HH:MM`, like `22:30`.");
      return;
    }
    user.endOfDayTime = endTime;
    user.setupStep = null;
    store.save();
    await sendMessage(chatId, "Great. I will send your daily total at " + endTime + ".");
    return;
  }

  const amount = parseWaterAmount(text);
  if (amount) {
    await recordDrink(chatId, user, amount);
    return;
  }

  await sendMessage(chatId, "I can log water from messages like `I drank 250ml` or `500ml`. Use /settings to change reminders.");
}

async function handleCallback(query) {
  const chatId = String(query.message.chat.id);
  const user = ensureUser(chatId, query.from);
  const data = query.data || "";

  try {
    if (data === "reset:confirm") {
      resetUser(chatId, query.from);
      await answerCallbackQuery(query.id, "Reset complete");
      await sendMessage(chatId, "Reset complete. Let's set you up again.");
      await sendWelcome(chatId);
      return;
    }

    if (data === "reset:cancel") {
      user.setupStep = null;
      store.save();
      await answerCallbackQuery(query.id, "Reset cancelled");
      await sendMessage(chatId, "Reset cancelled. Your settings and logs are unchanged.");
      return;
    }

    if (data.indexOf("interval:") === 0) {
      const minutes = parseInt(data.split(":")[1], 10);
      setIntervalMinutes(user, minutes);
      await answerCallbackQuery(query.id, "Reminder interval saved");
      await sendMessage(chatId, "⏰ Reminder interval saved: every " + formatDuration(minutes) + ".");
      return;
    }

    if (data === "end:custom") {
      user.setupStep = "custom_end_time";
      store.save();
      await answerCallbackQuery(query.id, "Send a custom time");
      await sendMessage(chatId, "Send your end-of-day time as `HH:MM`, like `22:30`.");
      return;
    }

    if (data.indexOf("end:") === 0) {
      user.endOfDayTime = data.split(":")[1] + ":" + data.split(":")[2];
      user.setupStep = null;
      store.save();
      await answerCallbackQuery(query.id, "Daily summary time saved");
      await sendMessage(chatId, "All set. I will check in every " + formatDuration(user.intervalMinutes) + " and send your daily total at " + user.endOfDayTime + ". Use the buttons below any time you drink water.");
      return;
    }

    await answerCallbackQuery(query.id, "Unknown action");
  } catch (error) {
    console.error("Callback error:", error.message);
    await answerCallbackQuery(query.id, "Something went wrong");
  }
}

function setIntervalMinutes(user, minutes) {
  user.intervalMinutes = minutes;
  user.lastReminderAt = nowProvider().toISOString();
  store.save();
}

async function sendWelcome(chatId) {
  await sendMessage(
    chatId,
    [
      "👋 Welcome to Water Bot.",
      "I will remind you every 3 hours by default and track your water over time.",
      "",
      "Useful commands:",
      "/drink 250 - log water",
      "/status - today's progress",
      "/weekprogress - this week",
      "/monthprogress - this month",
      "/lifetimeprogress - all-time total",
      "/interval 60 - change reminders",
      "",
      "🌙 First, choose your end-of-day summary time:"
    ].join("\n"),
    endTimeKeyboard()
  );
}

async function sendHelp(chatId) {
  await sendMessage(
    chatId,
    [
      "💧 Water bot commands:",
      "/start - set up reminders",
      "/help - show this list",
      "/drink 250 - log water",
      "/status - show progress",
      "/weekprogress - show this week's progress",
      "/monthprogress - show this month's progress",
      "/lifetimeprogress - show all-time progress",
      "/today - show today's total",
      "/reset - reset setup and start over",
      "/settings - change reminder setup",
      "/interval 60 - set reminder interval in minutes",
      "/end 22:00 - set daily summary time",
      "/shutup - pause reminders until tomorrow",
      "",
      "You can still log water with messages like `I drank 500ml`."
    ].join("\n")
  );
}

async function sendSettings(chatId, user) {
  const interval = user.intervalMinutes ? formatDuration(user.intervalMinutes) : "not set";
  const endTime = user.endOfDayTime || "not set";
  await sendMessage(
    chatId,
    "⚙️ Current settings:\nReminder interval: " + interval + "\nDaily summary: " + endTime + "\n\nChoose a reminder interval:",
    intervalKeyboard()
  );
}

async function recordDrink(chatId, user, amountMl) {
  const entry = {
    amountMl: amountMl,
    at: nowProvider().toISOString()
  };

  user.drinks.push(entry);
  store.save();
  await lifetimeStore.recordDrink({
    chatId: chatId,
    amountMl: amountMl,
    at: entry.at,
    localDate: localDateKey(nowProvider())
  });

  const today = totalForLocalDate(user, localDateKey(nowProvider()));
  await sendMessage(chatId, "✅ Logged " + amountMl + "ml.\nToday: " + today + "ml.");
}

async function sendTodaySummary(chatId, user) {
  const total = totalForLocalDate(user, localDateKey(nowProvider()));
  await sendMessage(chatId, "💧 Today\n" + progressBar(total, dailyWaterTargetMl) + " " + total + "ml / " + dailyWaterTargetMl + "ml");
}

async function sendProgress(chatId, user) {
  const total = totalForLocalDate(user, localDateKey(nowProvider()));
  const remaining = Math.max(dailyWaterTargetMl - total, 0);

  if (remaining === 0) {
    await sendMessage(chatId, "You have drunk " + total + "ml today. You hit the " + dailyWaterTargetMl + "ml daily target. Great job 💙");
    return;
  }

  await sendMessage(chatId, "You have drunk " + total + "ml today. Aim for " + dailyWaterTargetMl + "ml, so you need about " + remaining + "ml more today.");
}

async function sendStatus(chatId, user) {
  const total = totalForLocalDate(user, localDateKey(nowProvider()));
  await sendMessage(chatId, formatStatusMessage(total, dailyWaterTargetMl));
}

async function sendCheckIn(chatId, user) {
  const total = totalForLocalDate(user, localDateKey(nowProvider()));
  await sendMessage(chatId, formatCheckInMessage(total, dailyWaterTargetMl));
}

async function sendRangeProgress(chatId, range) {
  const now = nowProvider();
  const start = range === "week" ? weekStartDateKey(now) : monthStartDateKey(now);
  const end = localDateKey(now);
  const total = await lifetimeStore.totalForRange(chatId, start, end);
  const days = daysBetweenDateKeys(start, end) + 1;
  const goal = dailyWaterTargetMl * days;
  const title = range === "week" ? "📅 Week Progress" : "🗓️ Month Progress";

  await sendMessage(chatId, formatRangeProgressMessage(title, total, goal, start, end));
}

async function sendLifetimeProgress(chatId) {
  const total = await lifetimeStore.lifetimeTotal(chatId);
  await sendMessage(chatId, formatLifetimeProgressMessage(total));
}

async function runScheduler() {
  const now = nowProvider();
  const chats = Object.keys(store.data.users);

  for (const chatId of chats) {
    const user = store.data.users[chatId];
    if (!user.intervalMinutes || !user.endOfDayTime) continue;

    try {
      await maybeSendReminder(chatId, user, now);
      await maybeSendMorningMessage(chatId, user, now);
      await maybeSendDailySummary(chatId, user, now);
      await maybeSendWeeklyProgress(chatId, user, now);
    } catch (error) {
      console.error("Scheduler error for chat " + chatId + ":", error.message);
    }
  }
}

async function maybeSendReminder(chatId, user, now) {
  if (isPaused(user, now)) return;
  if (!isReminderTime(now, user)) return;

  const intervalMs = user.intervalMinutes * 60 * 1000;
  const lastReminderAt = user.lastReminderAt ? new Date(user.lastReminderAt) : new Date(0);

  if (now.getTime() - lastReminderAt.getTime() < intervalMs) return;

  user.lastReminderAt = now.toISOString();
  store.save();

  await sendCheckIn(chatId, user);
}

function isReminderTime(date, user) {
  const parts = localParts(date);
  const minuteOfDay = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  const endMinute = user && user.endOfDayTime ? timeToMinutes(user.endOfDayTime) : reminderEndMinute;
  return minuteOfDay >= reminderStartMinute && minuteOfDay < endMinute;
}

async function maybeSendMorningMessage(chatId, user, now) {
  if (isPaused(user, now)) return;

  const parts = localParts(now);
  const localTime = parts.hour + ":" + parts.minute;
  const dateKey = parts.year + "-" + parts.month + "-" + parts.day;

  if (localTime !== "09:00") return;
  if (user.lastMorningMessageDate === dateKey) return;

  user.lastMorningMessageDate = dateKey;
  store.save();
  await sendMessage(chatId, morningMessageForDate(dateKey));
}

async function maybeSendDailySummary(chatId, user, now) {
  if (isPaused(user, now)) return;

  const parts = localParts(now);
  const localTime = parts.hour + ":" + parts.minute;
  const summaryDate = user.endOfDayTime === "00:00" ? new Date(now.getTime() - 60 * 1000) : now;
  const dateKey = localDateKey(summaryDate);

  if (localTime !== user.endOfDayTime) return;
  if (user.lastDailySummaryDate === dateKey) return;

  const total = totalForLocalDate(user, dateKey);
  user.lastDailySummaryDate = dateKey;
  store.save();
  await sendMessage(chatId, dailySummaryMessage(total));
}

async function maybeSendWeeklyProgress(chatId, user, now) {
  if (isPaused(user, now)) return;

  const parts = localParts(now);
  const dateKey = parts.year + "-" + parts.month + "-" + parts.day;
  const localTime = parts.hour + ":" + parts.minute;
  const weekday = weekdayForDateKey(dateKey);

  if (weekday !== 0 || localTime !== "10:00") return;
  if (user.lastWeeklyProgressDate === dateKey) return;

  const start = weekStartDateKey(now);
  const total = await lifetimeStore.totalForRange(chatId, start, dateKey);
  const goal = dailyWaterTargetMl * 7;
  user.lastWeeklyProgressDate = dateKey;
  store.save();
  await sendMessage(chatId, formatRangeProgressMessage("📅 Weekly Progress", total, goal, start, dateKey));
}

function intervalKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: intervalOptions.map(function (option) {
        return [{ text: option.label, callback_data: "interval:" + option.minutes }];
      })
    }
  };
}

function endTimeKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        endTimeOptions.map(function (option) {
          return { text: option.label, callback_data: "end:" + option.value };
        }),
        [{ text: "Custom time", callback_data: "end:custom" }]
      ]
    }
  };
}

function quickDrinkKeyboard() {
  return {
    keyboard: [
      [{ text: "Drank 250ml" }, { text: "Drank 500ml" }],
      [{ text: "/status" }, { text: "/help" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    input_field_placeholder: "Log water"
  };
}

function resetConfirmKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Yes, reset", callback_data: "reset:confirm" },
          { text: "Cancel", callback_data: "reset:cancel" }
        ]
      ]
    }
  };
}

function ensureUser(chatId, from) {
  if (!store.data.users[chatId]) {
    store.data.users[chatId] = createUser(chatId, from);
    store.save();
  }
  return store.data.users[chatId];
}

function resetUser(chatId, from) {
  store.data.users[chatId] = createUser(chatId, from);
  store.data.users[chatId].setupStep = "end_time";
  store.save();
  return store.data.users[chatId];
}

function createUser(chatId, from) {
  return {
    chatId: chatId,
    firstName: from && from.first_name ? from.first_name : "",
    intervalMinutes: defaultIntervalMinutes,
    endOfDayTime: null,
    setupStep: null,
    startedAt: nowProvider().toISOString(),
    lastReminderAt: null,
    lastDailySummaryDate: null,
    lastMorningMessageDate: null,
    lastWeeklyProgressDate: null,
    pausedUntilDate: null,
    drinks: []
  };
}

function parseWaterAmount(text) {
  const match = String(text).toLowerCase().match(/(\d+(?:\.\d+)?)\s*(ml|milliliter|milliliters|l|liter|liters)?\b/);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const unit = match[2] || "ml";
  if (!isFinite(value) || value <= 0) return null;

  const amount = unit.charAt(0) === "l" && unit !== "ml" ? value * 1000 : value;
  return Math.round(amount);
}

function dailySummaryMessage(totalMl) {
  if (totalMl < 500) {
    return "You only drank " + totalMl + "ml today 😭 Please hydrate properly tomorrow.";
  }

  if (totalMl <= 1000) {
    return "You drank " + totalMl + "ml today. Better than nothing, but still too little 💧";
  }

  if (totalMl <= 1500) {
    return "You drank " + totalMl + "ml today. Not bad — decent progress 👍";
  }

  if (totalMl <= 2000) {
    return "Great job — you drank " + totalMl + "ml today! 💙";
  }

  if (totalMl <= 3000) {
    return "Excellent hydration today: " + totalMl + "ml 🌊 Keep it up!";
  }

  return "Hydration machine detected: " + totalMl + "ml today 🚰😂";
}

function morningMessageForDate(dateKey) {
  const index = dateKey.split("").reduce(function (sum, char) {
    return sum + char.charCodeAt(0);
  }, 0) % morningMessages.length;

  return morningMessages[index];
}

function parseDurationMinutes(text) {
  const match = String(text).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)?$/);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const unit = match[2] || "h";
  if (!isFinite(value) || value <= 0) return null;

  const minutes = unit.charAt(0) === "m" ? value : value * 60;
  return Math.round(minutes);
}

function parseIntervalMinutes(text) {
  const trimmed = String(text).trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  return parseDurationMinutes(trimmed);
}

function isValidInterval(minutes) {
  return Number.isInteger(minutes) && minutes >= minIntervalMinutes && minutes <= maxIntervalMinutes;
}

function parseTime(text) {
  const match = String(text).trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const minute = match[2] === undefined ? 0 : parseInt(match[2], 10);
  const meridiem = match[3];

  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return pad(hour) + ":" + pad(minute);
}

function timeToMinutes(time) {
  if (time === "00:00") return reminderEndMinute;
  const parts = String(time).split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function nextLocalDateKey(date) {
  return localDateKey(new Date(date.getTime() + 24 * 60 * 60 * 1000));
}

function weekStartDateKey(date) {
  const key = localDateKey(date);
  const weekday = weekdayForDateKey(key);
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  return addDaysToDateKey(key, -daysSinceMonday);
}

function monthStartDateKey(date) {
  const parts = localParts(date);
  return parts.year + "-" + parts.month + "-01";
}

function addDaysToDateKey(dateKey, days) {
  const parts = dateKey.split("-").map(function (part) {
    return parseInt(part, 10);
  });
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
  return date.toISOString().slice(0, 10);
}

function daysBetweenDateKeys(startDate, endDate) {
  const start = dateKeyToUtc(startDate);
  const end = dateKeyToUtc(endDate);
  return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
}

function weekdayForDateKey(dateKey) {
  return dateKeyToUtc(dateKey).getUTCDay();
}

function dateKeyToUtc(dateKey) {
  const parts = dateKey.split("-").map(function (part) {
    return parseInt(part, 10);
  });
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}

function isPaused(user, date) {
  if (!user.pausedUntilDate) return false;
  return localDateKey(date) < user.pausedUntilDate;
}

function progressBar(totalMl, goalMl) {
  const blocks = 10;
  const ratio = goalMl > 0 ? Math.min(totalMl / goalMl, 1) : 1;
  const filled = Math.round(ratio * blocks);
  return "🟦".repeat(filled) + "⬜".repeat(blocks - filled);
}

function progressPercent(totalMl, goalMl) {
  if (goalMl <= 0) return 100;
  return Math.round((totalMl / goalMl) * 100);
}

function formatStatusMessage(totalMl, goalMl) {
  const remaining = Math.max(goalMl - totalMl, 0);
  return [
    "💧 Status Update",
    progressBar(totalMl, goalMl) + " " + progressPercent(totalMl, goalMl) + "%",
    "Intake: " + totalMl + "ml",
    "Goal: " + goalMl + "ml",
    "Remaining: " + remaining + "ml"
  ].join("\n");
}

function formatCheckInMessage(totalMl, goalMl) {
  const remaining = Math.max(goalMl - totalMl, 0);
  const prompt = remaining === 0 ? "Goal reached. Nice work." : "Time for a glass of water.";
  return [
    "🚰 Check-in",
    progressBar(totalMl, goalMl) + " " + totalMl + "ml / " + goalMl + "ml",
    "Remaining: " + remaining + "ml",
    prompt
  ].join("\n");
}

function formatRangeProgressMessage(title, totalMl, goalMl, startDate, endDate) {
  const remaining = Math.max(goalMl - totalMl, 0);
  return [
    title,
    startDate + " to " + endDate,
    progressBar(totalMl, goalMl) + " " + progressPercent(totalMl, goalMl) + "%",
    "Total: " + totalMl + "ml",
    "Goal: " + goalMl + "ml",
    "Remaining: " + remaining + "ml"
  ].join("\n");
}

function formatLifetimeProgressMessage(totalMl) {
  const liters = (totalMl / 1000).toFixed(totalMl % 1000 === 0 ? 0 : 1);
  return [
    "🏆 Lifetime Progress",
    "Total: " + totalMl + "ml",
    "That is about " + liters + "L logged."
  ].join("\n");
}

function totalForLocalDate(user, dateKey) {
  return user.drinks.reduce(function (sum, drink) {
    return localDateKey(new Date(drink.at)) === dateKey ? sum + drink.amountMl : sum;
  }, 0);
}

function localDateKey(date) {
  const parts = localParts(date);
  return parts.year + "-" + parts.month + "-" + parts.day;
}

function localParts(date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const parts = {};
  formatter.formatToParts(date).forEach(function (part) {
    if (part.type !== "literal") parts[part.type] = part.value;
  });

  if (parts.hour === "24") parts.hour = "00";
  return parts;
}

function formatDuration(minutes) {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours + "h";
  }
  return minutes + "m";
}

function pad(number) {
  return String(number).padStart(2, "0");
}

function createStore(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const data = readJson(file) || { meta: {}, users: {} };
  if (!data.meta) data.meta = {};
  if (!data.users) data.users = {};

  return {
    data: data,
    save: function () {
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    }
  };
}

function createLifetimeStore(file) {
  let sqlite3;
  try {
    sqlite3 = require("sqlite3").verbose();
  } catch (error) {
    return createUnavailableLifetimeStore(error);
  }

  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new sqlite3.Database(file);
  db.serialize(function () {
    db.run("CREATE TABLE IF NOT EXISTS consumption (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, amount_ml INTEGER NOT NULL, at TEXT NOT NULL, local_date TEXT NOT NULL)");
    db.run("CREATE INDEX IF NOT EXISTS idx_consumption_chat_date ON consumption (chat_id, local_date)");
  });

  return {
    recordDrink: function (entry) {
      return new Promise(function (resolve, reject) {
        db.run(
          "INSERT INTO consumption (chat_id, amount_ml, at, local_date) VALUES (?, ?, ?, ?)",
          [entry.chatId, entry.amountMl, entry.at, entry.localDate],
          function (error) {
            if (error) reject(error);
            else resolve();
          }
        );
      });
    },
    totalForRange: function (chatId, startDate, endDate) {
      return new Promise(function (resolve, reject) {
        db.get(
          "SELECT COALESCE(SUM(amount_ml), 0) AS total FROM consumption WHERE chat_id = ? AND local_date >= ? AND local_date <= ?",
          [chatId, startDate, endDate],
          function (error, row) {
            if (error) reject(error);
            else resolve(row.total || 0);
          }
        );
      });
    },
    lifetimeTotal: function (chatId) {
      return new Promise(function (resolve, reject) {
        db.get(
          "SELECT COALESCE(SUM(amount_ml), 0) AS total FROM consumption WHERE chat_id = ?",
          [chatId],
          function (error, row) {
            if (error) reject(error);
            else resolve(row.total || 0);
          }
        );
      });
    }
  };
}

function createUnavailableLifetimeStore(error) {
  if (shouldStart) {
    console.warn("SQLite lifetime tracking is unavailable. Run `npm install` to install sqlite3. " + error.message);
  }

  return {
    recordDrink: async function () {},
    totalForRange: async function () {
      return 0;
    },
    lifetimeTotal: async function () {
      return 0;
    }
  };
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error("Could not read data file:", error.message);
    return null;
  }
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);

  lines.forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charAt(0) === "#") return;

    const index = trimmed.indexOf("=");
    if (index === -1) return;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  });
}

function api(method, payload) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify(payload || {});
    const request = https.request(apiBase + "/" + method, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, function (response) {
      let raw = "";
      response.on("data", function (chunk) {
        raw += chunk;
      });
      response.on("end", function () {
        try {
          const parsed = JSON.parse(raw);
          if (!parsed.ok) {
            reject(new Error(parsed.description || "Telegram API request failed"));
            return;
          }
          resolve(parsed.result);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function sendMessage(chatId, text, extra) {
  const payload = Object.assign({
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown",
    reply_markup: quickDrinkKeyboard()
  }, extra || {});

  return apiRequest("sendMessage", payload);
}

function answerCallbackQuery(callbackQueryId, text) {
  return apiRequest("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text
  });
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function configureForTest(options) {
  options = options || {};
  if (options.store) {
    store = options.store;
    updateOffset = store.data.meta.updateOffset || 0;
  }
  if (options.lifetimeStore) lifetimeStore = options.lifetimeStore;
  if (options.apiRequest) apiRequest = options.apiRequest;
  if (options.nowProvider) nowProvider = options.nowProvider;
}

module.exports = {
  configureForTest: configureForTest,
  handleUpdate: handleUpdate,
  runScheduler: runScheduler,
  createStore: createStore,
  createLifetimeStore: createLifetimeStore,
  createUser: createUser,
  parseWaterAmount: parseWaterAmount,
  parseIntervalMinutes: parseIntervalMinutes,
  isValidInterval: isValidInterval,
  parseTime: parseTime,
  progressBar: progressBar,
  formatStatusMessage: formatStatusMessage,
  formatCheckInMessage: formatCheckInMessage,
  formatRangeProgressMessage: formatRangeProgressMessage,
  formatLifetimeProgressMessage: formatLifetimeProgressMessage,
  weekStartDateKey: weekStartDateKey,
  monthStartDateKey: monthStartDateKey,
  isReminderTime: isReminderTime,
  maybeSendDailySummary: maybeSendDailySummary,
  maybeSendWeeklyProgress: maybeSendWeeklyProgress
};
