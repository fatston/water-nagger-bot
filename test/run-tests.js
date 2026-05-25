"use strict";

const assert = require("assert");
const bot = require("../src/bot");

const tests = [];

function test(name, fn) {
  tests.push({ name: name, fn: fn });
}

function createHarness(now) {
  const sent = [];
  const lifetimeEntries = [];
  const store = {
    data: { meta: {}, users: {} },
    saves: 0,
    save: function () {
      this.saves += 1;
    }
  };
  let currentNow = new Date(now || "2026-05-25T02:00:00.000Z");

  bot.configureForTest({
    store: store,
    lifetimeStore: {
      entries: lifetimeEntries,
      recordDrink: async function (entry) {
        lifetimeEntries.push(entry);
      },
      totalForRange: async function (chatId, startDate, endDate) {
        return lifetimeEntries.reduce(function (sum, entry) {
          if (entry.chatId !== String(chatId)) return sum;
          if (entry.localDate < startDate || entry.localDate > endDate) return sum;
          return sum + entry.amountMl;
        }, 0);
      },
      totalsByDate: async function (chatId, startDate, endDate) {
        return lifetimeEntries.reduce(function (totals, entry) {
          if (entry.chatId !== String(chatId)) return totals;
          if (entry.localDate < startDate || entry.localDate > endDate) return totals;
          totals[entry.localDate] = (totals[entry.localDate] || 0) + entry.amountMl;
          return totals;
        }, {});
      },
      lifetimeTotal: async function (chatId) {
        return lifetimeEntries.reduce(function (sum, entry) {
          return entry.chatId === String(chatId) ? sum + entry.amountMl : sum;
        }, 0);
      },
      deleteForRange: async function (chatId, startDate, endDate) {
        for (let index = lifetimeEntries.length - 1; index >= 0; index -= 1) {
          const entry = lifetimeEntries[index];
          if (entry.chatId === String(chatId) && entry.localDate >= startDate && entry.localDate <= endDate) {
            lifetimeEntries.splice(index, 1);
          }
        }
      },
      deleteUser: async function (chatId) {
        for (let index = lifetimeEntries.length - 1; index >= 0; index -= 1) {
          if (lifetimeEntries[index].chatId === String(chatId)) {
            lifetimeEntries.splice(index, 1);
          }
        }
      }
    },
    nowProvider: function () {
      return currentNow;
    },
    apiRequest: async function (method, payload) {
      sent.push({ method: method, payload: payload });
      if (method === "sendMessage") return { message_id: sent.length };
      if (method === "answerCallbackQuery") return true;
      return [];
    }
  });

  return {
    store: store,
    sent: sent,
    lifetimeEntries: lifetimeEntries,
    addLifetimeEntry: function (amountMl, localDate, chatId) {
      lifetimeEntries.push({
        chatId: String(chatId || 1),
        amountMl: amountMl,
        at: localDate + "T02:00:00.000Z",
        localDate: localDate
      });
    },
    setNow: function (iso) {
      currentNow = new Date(iso);
    },
    message: function (text, chatId) {
      return {
        message: {
          chat: { id: chatId || 1 },
          from: { id: chatId || 1, first_name: "Test" },
          text: text
        }
      };
    },
    callback: function (data, chatId) {
      return {
        callback_query: {
          id: "callback-" + data,
          data: data,
          from: { id: chatId || 1, first_name: "Test" },
          message: { chat: { id: chatId || 1 } }
        }
      };
    },
    lastText: function () {
      return sent[sent.length - 1].payload.text;
    }
  };
}

function addUser(store, overrides) {
  const user = Object.assign(bot.createUser("1", { first_name: "Test" }), {
    intervalMinutes: 60,
    endOfDayTime: "22:00",
    lastReminderAt: "2026-05-24T00:00:00.000Z"
  }, overrides || {});
  store.data.users["1"] = user;
  return user;
}

test("unit: parses and validates reminder intervals", function () {
  assert.strictEqual(bot.parseIntervalMinutes("60"), 60);
  assert.strictEqual(bot.parseIntervalMinutes("2h"), 120);
  assert.strictEqual(bot.parseIntervalMinutes("90m"), 90);
  assert.strictEqual(bot.isValidInterval(15), true);
  assert.strictEqual(bot.isValidInterval(360), true);
  assert.strictEqual(bot.isValidInterval(14), false);
  assert.strictEqual(bot.isValidInterval(361), false);
});

test("unit: renders progress bars below, at, and above goal", function () {
  assert.strictEqual(bot.progressBar(800, 2000), "🟦🟦🟦🟦⬜⬜⬜⬜⬜⬜");
  assert.strictEqual(bot.progressBar(2000, 2000), "🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦");
  assert.strictEqual(bot.progressBar(2500, 2000), "🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦");
});

test("unit: formats status and check-in messages", function () {
  const status = bot.formatStatusMessage(750, 2000);
  assert.ok(status.includes("💧 Status Update"));
  assert.ok(status.includes("Intake: 750ml"));
  assert.ok(status.includes("Goal: 2000ml"));
  assert.ok(status.includes("Remaining: 1250ml"));

  const checkIn = bot.formatCheckInMessage(750, 2000);
  assert.ok(checkIn.includes("🚰 Check-in"));
  assert.ok(checkIn.includes("750ml / 2000ml"));
});

test("unit: formats range and lifetime progress messages", function () {
  const week = bot.formatRangeProgressMessage("📅 Week Progress", 3000, 14000, "2026-05-25", "2026-05-31");
  assert.ok(week.includes("📅 Week Progress"));
  assert.ok(week.includes("Total: 3000ml"));
  assert.ok(week.includes("Goal: 14000ml"));

  const weekDaily = bot.formatWeekProgressMessage({ "2026-05-25": 500, "2026-05-27": 1200 }, "2026-05-25", "2026-05-31", 2000);
  assert.ok(weekDaily.includes("05/25"));
  assert.ok(weekDaily.includes("500ml"));
  assert.ok(weekDaily.includes("05/26"));
  assert.ok(weekDaily.includes("0ml"));
  assert.ok(weekDaily.includes("05/31"));

  const lifetime = bot.formatLifetimeProgressMessage(2500);
  assert.ok(lifetime.includes("🏆 Lifetime Progress"));
  assert.ok(lifetime.includes("2500ml"));
  assert.ok(lifetime.includes("2.5L"));
});

test("integration: /help returns slash command list", async function () {
  const h = createHarness();
  await bot.handleUpdate(h.message("/help"));
  const text = h.lastText();
  assert.ok(text.includes("/reset"));
  assert.ok(text.includes("/resetall"));
  assert.ok(text.includes("/status"));
  assert.ok(text.includes("/weekprogress"));
  assert.ok(text.includes("/monthprogress"));
  assert.ok(text.includes("/lifetimeprogress"));
  assert.ok(text.includes("/interval 60"));
  assert.ok(text.includes("/shutup"));
  assert.ok(text.includes("/starttalking"));
  assert.strictEqual(text.includes("/week-progress"), false);
  assert.strictEqual(text.includes("/month-progress"), false);
  assert.strictEqual(text.includes("/lifetime-progress"), false);
  assert.strictEqual(text.includes("/shut-up"), false);
  assert.strictEqual(text.includes("how am I doing?"), false);
});

test("integration: /reset resets today's water only", async function () {
  const h = createHarness("2026-05-25T02:00:00.000Z");
  const user = addUser(h.store, {
    drinks: [
      { amountMl: 250, at: "2026-05-24T02:00:00.000Z" },
      { amountMl: 500, at: "2026-05-25T02:00:00.000Z" }
    ]
  });
  h.addLifetimeEntry(250, "2026-05-24");
  h.addLifetimeEntry(500, "2026-05-25");

  await bot.handleUpdate(h.message("/reset"));

  assert.strictEqual(user.drinks.length, 1);
  assert.strictEqual(user.drinks[0].amountMl, 250);
  assert.strictEqual(h.lifetimeEntries.length, 1);
  assert.strictEqual(h.lifetimeEntries[0].localDate, "2026-05-24");
  assert.strictEqual(user.intervalMinutes, 60);
  assert.ok(h.lastText().includes("Today's water tracking has been reset"));

  await bot.handleUpdate(h.message("/monthprogress"));
  assert.ok(h.lastText().includes("Total: 250ml"));

  await bot.handleUpdate(h.message("/lifetimeprogress"));
  assert.ok(h.lastText().includes("Total: 250ml"));
});

test("integration: /resetall asks for confirmation before full setup reset", async function () {
  const h = createHarness("2026-05-25T02:00:00.000Z");
  const user = addUser(h.store, {
    drinks: [{ amountMl: 500, at: "2026-05-25T02:00:00.000Z" }]
  });

  await bot.handleUpdate(h.message("/resetall"));

  assert.strictEqual(user.drinks.length, 1);
  assert.strictEqual(user.setupStep, "confirm_reset_all");
  assert.ok(h.lastText().includes("Reset everything?"));
  assert.strictEqual(h.sent[h.sent.length - 1].payload.reply_markup.inline_keyboard[0][0].callback_data, "resetall:confirm");
});

test("integration: resetall confirmation clears settings and user db rows", async function () {
  const h = createHarness("2026-05-25T02:00:00.000Z");
  addUser(h.store, {
    drinks: [{ amountMl: 500, at: "2026-05-25T02:00:00.000Z" }]
  });
  h.addLifetimeEntry(500, "2026-05-25");
  h.addLifetimeEntry(700, "2026-05-24", 2);

  await bot.handleUpdate(h.callback("resetall:confirm"));

  const user = h.store.data.users["1"];
  assert.strictEqual(user.intervalMinutes, 180);
  assert.strictEqual(user.endOfDayTime, null);
  assert.strictEqual(user.setupStep, "end_time");
  assert.deepStrictEqual(user.drinks, []);
  assert.strictEqual(h.lifetimeEntries.length, 1);
  assert.strictEqual(h.lifetimeEntries[0].chatId, "2");
  assert.ok(h.sent[h.sent.length - 1].payload.text.includes("choose your end-of-day summary time"));
});

test("integration: /start uses a 3 hour default and asks for end-of-day", async function () {
  const h = createHarness();

  await bot.handleUpdate(h.message("/start"));

  const user = h.store.data.users["1"];
  assert.strictEqual(user.intervalMinutes, 180);
  assert.strictEqual(user.setupStep, "end_time");
  assert.ok(h.lastText().includes("every 3 hours by default"));
  assert.ok(h.lastText().includes("/interval 60"));
  assert.ok(h.sent[h.sent.length - 1].payload.reply_markup.inline_keyboard[0][0].callback_data.indexOf("end:") === 0);
});

test("integration: /shutup pauses reminders until next day", async function () {
  const h = createHarness("2026-05-25T02:00:00.000Z");
  const user = addUser(h.store);

  await bot.handleUpdate(h.message("/shutup"));
  assert.strictEqual(user.pausedUntilDate, "2026-05-26");
  assert.ok(h.lastText().includes("Paused for today"));

  const sentAfterPauseCommand = h.sent.length;
  await bot.runScheduler();
  assert.strictEqual(h.sent.length, sentAfterPauseCommand);

  h.setNow("2026-05-26T02:00:00.000Z");
  await bot.runScheduler();
  assert.ok(h.lastText().includes("🚰 Check-in"));
});

test("integration: /starttalking resumes reminders", async function () {
  const h = createHarness("2026-05-25T02:00:00.000Z");
  const user = addUser(h.store, { pausedUntilDate: "2026-05-26" });

  await bot.handleUpdate(h.message("/starttalking"));

  assert.strictEqual(user.pausedUntilDate, null);
  assert.ok(h.lastText().includes("Reminders are on again"));
});

test("integration: /interval 60 updates reminder interval", async function () {
  const h = createHarness();
  const user = addUser(h.store, { intervalMinutes: 120 });

  await bot.handleUpdate(h.message("/interval 60"));

  assert.strictEqual(user.intervalMinutes, 60);
  assert.ok(h.lastText().includes("60 minutes"));
});

test("integration: reply keyboard shows help and status buttons", async function () {
  const h = createHarness();

  await bot.handleUpdate(h.message("/help"));

  const keyboard = h.sent[h.sent.length - 1].payload.reply_markup.keyboard;
  assert.deepStrictEqual(keyboard, [
    [{ text: "Drank 250ml" }, { text: "Drank 500ml" }],
    [{ text: "/status" }, { text: "/help" }]
  ]);
});

test("integration: invalid interval input returns helpful error", async function () {
  const h = createHarness();
  const user = addUser(h.store, { intervalMinutes: 120 });

  await bot.handleUpdate(h.message("/interval 10"));
  assert.strictEqual(user.intervalMinutes, 120);
  assert.ok(h.lastText().includes("15 to 360 minutes"));

  await bot.handleUpdate(h.message("/interval soon"));
  assert.ok(h.lastText().includes("/interval 60"));
});

test("integration: custom end-of-day time is respected", async function () {
  const h = createHarness("2026-05-25T14:29:00.000Z");
  addUser(h.store, {
    endOfDayTime: "22:30",
    drinks: [{ amountMl: 500, at: "2026-05-25T02:00:00.000Z" }]
  });

  await bot.runScheduler();
  assert.ok(h.lastText().includes("🚰 Check-in"));

  h.sent.length = 0;
  h.setNow("2026-05-25T14:30:00.000Z");
  await bot.runScheduler();
  assert.strictEqual(h.sent.length, 1);
  assert.ok(h.lastText().includes("500ml"));
  assert.strictEqual(h.lastText().includes("🚰 Check-in"), false);
});

test("integration: /status returns Status Update format", async function () {
  const h = createHarness();
  addUser(h.store, {
    drinks: [{ amountMl: 750, at: "2026-05-25T02:00:00.000Z" }]
  });

  await bot.handleUpdate(h.message("/status"));
  const text = h.lastText();
  assert.ok(text.includes("💧 Status Update"));
  assert.ok(text.includes("Intake: 750ml"));
  assert.ok(text.includes("Remaining: 1250ml"));
});

test("integration: drinking water writes to lifetime store", async function () {
  const h = createHarness("2026-05-25T02:00:00.000Z");
  addUser(h.store);

  await bot.handleUpdate(h.message("/drink 250"));

  assert.strictEqual(h.lifetimeEntries.length, 1);
  assert.strictEqual(h.lifetimeEntries[0].amountMl, 250);
  assert.strictEqual(h.lifetimeEntries[0].localDate, "2026-05-25");
});

test("integration: /weekprogress shows this week's lifetime data", async function () {
  const h = createHarness("2026-05-28T02:00:00.000Z");
  addUser(h.store);
  h.addLifetimeEntry(500, "2026-05-25");
  h.addLifetimeEntry(700, "2026-05-28");
  h.addLifetimeEntry(900, "2026-05-18");

  await bot.handleUpdate(h.message("/weekprogress"));

  const text = h.lastText();
  assert.ok(text.includes("📅 Week Progress"));
  assert.ok(text.includes("2026-05-22 to 2026-05-28"));
  assert.ok(text.includes("Total: 1200ml"));
  assert.ok(text.includes("05/22"));
  assert.ok(text.includes("05/23"));
  assert.ok(text.includes("05/24"));
  assert.ok(text.includes("05/25"));
  assert.ok(text.includes("05/26"));
  assert.ok(text.includes("05/27"));
  assert.ok(text.includes("05/28"));
  assert.ok(text.includes("05/22 ⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜ 0ml"));
});

test("integration: old hyphenated progress and pause commands remain aliases", async function () {
  const h = createHarness("2026-05-28T02:00:00.000Z");
  const user = addUser(h.store);
  h.addLifetimeEntry(500, "2026-05-25");

  await bot.handleUpdate(h.message("/week-progress"));
  assert.ok(h.lastText().includes("📅 Week Progress"));

  await bot.handleUpdate(h.message("/shut-up"));
  assert.strictEqual(user.pausedUntilDate, "2026-05-29");
});

test("integration: /monthprogress shows this month's lifetime data", async function () {
  const h = createHarness("2026-05-28T02:00:00.000Z");
  addUser(h.store);
  h.addLifetimeEntry(500, "2026-05-01");
  h.addLifetimeEntry(700, "2026-05-28");
  h.addLifetimeEntry(900, "2026-04-30");

  await bot.handleUpdate(h.message("/monthprogress"));

  const text = h.lastText();
  assert.ok(text.includes("🗓️ Month Progress"));
  assert.ok(text.includes("2026-05-01 to 2026-05-28"));
  assert.ok(text.includes("Total: 1200ml"));
});

test("integration: /lifetimeprogress shows all-time lifetime data", async function () {
  const h = createHarness("2026-05-28T02:00:00.000Z");
  addUser(h.store);
  h.addLifetimeEntry(500, "2026-05-01");
  h.addLifetimeEntry(700, "2026-05-28");
  h.addLifetimeEntry(900, "2026-04-30");

  await bot.handleUpdate(h.message("/lifetimeprogress"));

  const text = h.lastText();
  assert.ok(text.includes("🏆 Lifetime Progress"));
  assert.ok(text.includes("Total: 2100ml"));
  assert.ok(text.includes("2.1L"));
});

test("integration: weekly progress sends once on Sunday at 10am", async function () {
  const h = createHarness("2026-05-31T02:00:00.000Z");
  const user = addUser(h.store, { lastReminderAt: "2026-05-31T02:00:00.000Z" });
  h.addLifetimeEntry(500, "2026-05-25");
  h.addLifetimeEntry(700, "2026-05-31");

  await bot.runScheduler();

  assert.ok(h.lastText().includes("Week Progress"));
  assert.ok(h.lastText().includes("Total: 1200ml"));
  assert.ok(h.lastText().includes("05/25"));
  assert.ok(h.lastText().includes("05/31"));
  assert.strictEqual(user.lastWeeklyProgressDate, "2026-05-31");

  const sentAfterFirstRun = h.sent.length;
  await bot.runScheduler();
  assert.strictEqual(h.sent.length, sentAfterFirstRun);
});

test("integration: reminder uses Check-in format with progress", async function () {
  const h = createHarness("2026-05-25T02:00:00.000Z");
  addUser(h.store, {
    drinks: [{ amountMl: 750, at: "2026-05-25T02:00:00.000Z" }]
  });

  await bot.runScheduler();

  const text = h.lastText();
  assert.ok(text.includes("🚰 Check-in"));
  assert.ok(text.includes("750ml / 2000ml"));
  assert.ok(text.includes("🟦"));
});

(async function run() {
  let passed = 0;
  for (const entry of tests) {
    try {
      await entry.fn();
      passed += 1;
      console.log("ok - " + entry.name);
    } catch (error) {
      console.error("not ok - " + entry.name);
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
      return;
    }
  }

  console.log("\n" + passed + " tests passed");
})();
