import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

function positiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadConfig() {
  const salonConfigPath = path.resolve(process.env.SALON_CONFIG ?? "data/salon.json");
  const salon = JSON.parse(fs.readFileSync(salonConfigPath, "utf8"));
  if (salon.masters !== undefined && !Array.isArray(salon.masters)) {
    throw new Error("SALON_CONFIG masters must be an array when provided");
  }
  const masters = salon.masters ?? [];

  const ids = new Set();
  const telegramIds = new Set();
  for (const master of masters) {
    if (!master.id || !master.name || ids.has(master.id)) {
      throw new Error("Every master must have a name and unique id");
    }
    if (master.telegramId) {
      const telegramId = String(master.telegramId);
      if (!/^\d+$/.test(telegramId) || telegramIds.has(telegramId)) {
        throw new Error(`Every configured master Telegram ID must be numeric and unique: ${master.id}`);
      }
      master.telegramId = telegramId;
      telegramIds.add(telegramId);
    }
    ids.add(master.id);
  }

  const sessionSecret = process.env.SESSION_SECRET?.trim();
  if (!sessionSecret || sessionSecret.length < 32 || sessionSecret.startsWith("replace-this")) {
    throw new Error("Set SESSION_SECRET in .env to a random value of at least 32 characters");
  }
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const telegramBotUsername = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "") ?? "";
  const publicAppUrl = process.env.PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? "";
  if (telegramBotToken && !telegramBotUsername) {
    throw new Error("Set TELEGRAM_BOT_USERNAME when TELEGRAM_BOT_TOKEN is configured");
  }
  if (publicAppUrl && new URL(publicAppUrl).protocol !== "https:") {
    throw new Error("PUBLIC_APP_URL must use HTTPS for Telegram Mini Apps");
  }

  return {
    salonName: salon.salonName ?? "Nail Studio",
    masters,
    timezone: process.env.TIMEZONE ?? "Europe/Moscow",
    databasePath: path.resolve(process.env.DATABASE_PATH ?? "data/bookings.sqlite3"),
    uploadsPath: path.resolve("data/uploads"),
    sessionDatabasePath: path.resolve("data/sessions.sqlite3"),
    sessionSecret,
    telegramBotToken,
    telegramBotUsername,
    publicAppUrl,
    port: positiveInteger("PORT", 3000),
    slotStepMinutes: positiveInteger("SLOT_STEP_MINUTES", 30),
    bookingDurationMinutes: positiveInteger("BOOKING_DURATION_MINUTES", 60),
    bookingHorizonDays: 14,
  };
}
