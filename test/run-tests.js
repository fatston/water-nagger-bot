"use strict";

const assert = require("assert");
const bot = require("../src/bot");

const tests = [];

function test(name, fn) {
  tests.push({ name: name, fn: fn });
}

function createHarness(now) {
  const sent = [];
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

test("integration: /help returns slash command list", async function () {
  const h = createHarness();
  await bot.handleUpdate(h.message("/help"));
  const text = h.lastText();
  assert.ok(text.includes("/reset"));
  assert.ok(text.includes("/status"));
  assert.ok(text.includes("/interval 60"));
  assert.ok(text.includes("/shut-up"));
  assert.strictEqual(text.includes("how am I doing?"), false);
});

test("integration: /reset resets today's amount only", async function () {
  const h = createHarness("2026-05-25T02:00:00.000Z");
  const user = addUser(h.store, {
    drinks: [
      { amountMl: 250, at: "2026-05-24T02:00:00.000Z" },
      { amountMl: 500, at: "2026-05-25T02:00:00.000Z" }
    ]
  });

  await bot.handleUpdate(h.message("/reset"));

  assert.strictEqual(user.drinks.length, 1);
  assert.strictEqual(user.drinks[0].amountMl, 250);
  assert.strictEqual(user.intervalMinutes, 60);
  assert.ok(h.lastText().includes("settings are unchanged"));
});

test("integration: /shut-up pauses reminders until next day", async function () {
  const h = createHarness("2026-05-25T02:00:00.000Z");
  const user = addUser(h.store);

  await bot.handleUpdate(h.message("/shut-up"));
  assert.strictEqual(user.pausedUntilDate, "2026-05-26");
  assert.ok(h.lastText().includes("Paused for today"));

  const sentAfterPauseCommand = h.sent.length;
  await bot.runScheduler();
  assert.strictEqual(h.sent.length, sentAfterPauseCommand);

  h.setNow("2026-05-26T02:00:00.000Z");
  await bot.runScheduler();
  assert.ok(h.lastText().includes("🚰 Check-in"));
});

test("integration: /interval 60 updates reminder interval", async function () {
  const h = createHarness();
  const user = addUser(h.store, { intervalMinutes: 120 });

  await bot.handleUpdate(h.message("/interval 60"));

  assert.strictEqual(user.intervalMinutes, 60);
  assert.ok(h.lastText().includes("60 minutes"));
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
