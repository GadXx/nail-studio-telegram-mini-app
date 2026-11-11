import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import session from "express-session";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import { DateTime } from "luxon";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { getAvailableDays, getAvailableSlots } from "./schedule.js";
import { BookingStorage } from "./storage.js";
import { SQLiteSessionStore } from "./session-store.js";
import { sendTelegramMessage, startTelegramBot, verifyTelegramInitData } from "./telegram.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(projectRoot);
const config = loadConfig();
const storage = new BookingStorage(config.databasePath);
storage.seedMasters(config.masters);
if (storage.listMasters(false).length === 0) {
  throw new Error("Нет мастеров в базе. Заполни data/salon.json при первой установке.");
}
const sessions = new SQLiteSessionStore(config.sessionDatabasePath);
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 3, fileSize: 5 * 1024 * 1024, fields: 8, fieldSize: 16 * 1024 },
});
const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Слишком много попыток записи. Попробуй позже." },
});
const telegramAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Слишком много попыток входа. Попробуй позже." },
});

async function notifyMaster(master, booking) {
  if (!config.telegramBotToken || !master.telegramId) return;
  const startsAt = DateTime.fromMillis(booking.startsAt, { zone: config.timezone });
  const details = [
    `Клиент: ${booking.customerName}`,
    booking.telegramUsername ? `Telegram: @${booking.telegramUsername}` : booking.phone ? `Телефон: ${booking.phone}` : "",
    booking.description ? `Пожелание: ${booking.description}` : "",
    booking.photoCount ? `Фото: ${booking.photoCount}` : "",
  ].filter(Boolean).join("\n");
  const text = `Новая запись к вам\n${startsAt.toFormat("dd.LL.yyyy, HH:mm")}\n${details}`;
  await sendTelegramMessage(config.telegramBotToken, master.telegramId, text);
}

async function notifyCustomerBookingMoved(booking, master, startsAt) {
  if (!config.telegramBotToken || !booking.user_id) return false;
  const when = DateTime.fromMillis(startsAt, { zone: config.timezone }).toFormat("dd.LL.yyyy, HH:mm");
  await sendTelegramMessage(config.telegramBotToken, booking.user_id,
    `Ваша запись перенесена на ${when}. Мастер: ${master.name}.`);
  return true;
}

async function notifyCustomerBookingCancelled(booking) {
  if (!config.telegramBotToken || !booking.user_id) return false;
  await sendTelegramMessage(config.telegramBotToken, booking.user_id,
    "Ваша запись отменена. Если это ошибка, свяжитесь с салоном.");
  return true;
}

function detectImage(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

function publicBooking(booking, includePhotos = false) {
  const photoFiles = JSON.parse(booking.photos_json || "[]");
  const startsAt = DateTime.fromMillis(booking.starts_at, { zone: config.timezone });
  return {
    id: booking.id,
    masterId: booking.master_id,
    masterName: booking.master_name,
    customerName: booking.customer_name,
    telegramUsername: booking.telegram_username ?? "",
    phone: booking.phone,
    startsAt: booking.starts_at,
    endsAt: booking.ends_at,
    dateLabel: startsAt.toFormat("dd.LL.yyyy"),
    timeLabel: startsAt.toFormat("HH:mm"),
    description: booking.description,
    photoCount: photoFiles.length,
    photos: includePhotos ? photoFiles.map((_, index) => `/api/master/bookings/${booking.id}/photos/${index}`) : undefined,
    status: booking.status,
    source: booking.source,
  };
}

function masterForRequest(req) {
  const telegramId = req.session.telegramUser?.id;
  return telegramId ? storage.getActiveMasterByTelegramId(telegramId) : undefined;
}

function requireMaster(req, res, next) {
  const master = masterForRequest(req);
  if (!master) return res.status(401).json({ error: "Войди в аккаунт мастера." });
  req.master = master;
  next();
}

function requireMainMaster(req, res, next) {
  const master = masterForRequest(req);
  if (!master) return res.status(401).json({ error: "Войди в аккаунт мастера." });
  if (!master.isMain) return res.status(403).json({ error: "Это действие доступно главному мастеру." });
  req.master = master;
  next();
}

function requireTelegramUser(req, res, next) {
  if (!req.session.telegramUser) return res.status(401).json({ error: "Открой приложение из Telegram." });
  next();
}

function findAvailableSlot(master, startsAt, ignoreBookingId = null) {
  if (!Number.isSafeInteger(startsAt) || startsAt <= Date.now()) return null;
  const day = DateTime.fromMillis(startsAt, { zone: config.timezone });
  const allowedDays = getAvailableDays(master, config.timezone, config.bookingHorizonDays);
  if (!allowedDays.some((allowedDay) => allowedDay.toISODate() === day.toISODate())) return null;
  return getAvailableSlots(master, day.toISODate(), config, storage, ignoreBookingId)
    .find((slot) => slot.start.toMillis() === startsAt) ?? null;
}

function minuteOfDay(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || ![0, 30].includes(minute)) return null;
  return hour * 60 + minute;
}

function isDateWithinHorizon(date, timezone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = DateTime.fromISO(date, { zone: timezone });
  if (!parsed.isValid || parsed.toISODate() !== date) return false;
  const today = DateTime.now().setZone(timezone).startOf("day");
  return parsed.startOf("day") >= today && parsed.startOf("day") < today.plus({ days: config.bookingHorizonDays });
}

app.disable("x-powered-by");
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://telegram.org"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'", "https://web.telegram.org", "https://webk.telegram.org", "https://webz.telegram.org"],
    },
  },
}));
app.use(express.json({ limit: "32kb" }));
app.use(session({
  name: "nails.sid",
  secret: config.sessionSecret,
  store: sessions,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    maxAge: 8 * 60 * 60 * 1000,
  },
}));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.get("origin")) {
    try {
      if (new URL(req.get("origin")).host !== req.get("host")) {
        return res.status(403).json({ error: "Запрос с другого сайта запрещён." });
      }
    } catch {
      return res.status(403).json({ error: "Некорректный источник запроса." });
    }
  }
  next();
});

app.get("/api/salon", (_req, res) => {
  res.json({
    name: config.salonName,
    masters: storage.listMasters().map(({ id, name }) => ({ id, name })),
    durationMinutes: config.bookingDurationMinutes,
    horizonDays: config.bookingHorizonDays,
    timezone: config.timezone,
  });
});

app.get("/api/telegram/config", (_req, res) => {
  res.json({
    enabled: Boolean(config.telegramBotToken && config.telegramBotUsername && config.publicAppUrl),
    botUrl: config.telegramBotUsername && config.publicAppUrl ? `https://t.me/${config.telegramBotUsername}` : null,
  });
});

app.get("/api/availability", (req, res) => {
  const master = storage.getMaster(String(req.query.masterId ?? ""));
  const date = String(req.query.date ?? "");
  if (!master?.active || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Выбери мастера и корректную дату." });
  }
  const allowedDays = getAvailableDays(master, config.timezone, config.bookingHorizonDays);
  if (!allowedDays.some((day) => day.toISODate() === date)) return res.json({ slots: [] });
  const ownMaster = masterForRequest(req);
  const requestedIgnoreId = Number(req.query.ignoreBookingId);
  const ownBooking = ownMaster && ownMaster.id === master.id && Number.isSafeInteger(requestedIgnoreId)
    ? storage.getMasterBooking(ownMaster.id, requestedIgnoreId)
    : null;
  const ignoreBookingId = ownBooking?.status === "active" ? ownBooking.id : null;
  const slots = getAvailableSlots(master, date, config, storage, ignoreBookingId).map(({ start }) => ({
    startsAt: start.toMillis(),
    label: start.toFormat("HH:mm"),
  }));
  res.json({ slots });
});

app.post("/api/auth/telegram", telegramAuthLimiter, async (req, res) => {
  if (!config.telegramBotToken) return res.status(503).json({ error: "Бот Telegram ещё не настроен." });
  const user = verifyTelegramInitData(req.body?.initData, config.telegramBotToken);
  if (!user) return res.status(401).json({ error: "Не удалось проверить вход через Telegram. Закрой и заново открой приложение." });
  const master = storage.getActiveMasterByTelegramId(user.id) ?? null;
  const request = storage.getMasterRequest(user.id);
  await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  req.session.telegramUser = user;
  await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
  res.json({ user, master, masterRequest: request ? { status: request.status } : null });
});

app.get("/api/auth/me", (req, res) => {
  const master = masterForRequest(req);
  res.json({
    user: req.session.telegramUser ?? null,
    master,
    masterRequest: req.session.telegramUser ? storage.getMasterRequest(req.session.telegramUser.id) : null,
  });
});

app.post("/api/master-requests", telegramAuthLimiter, requireTelegramUser, async (req, res) => {
  const user = req.session.telegramUser;
  if (storage.getActiveMasterByTelegramId(user.id)) return res.status(409).json({ error: "У тебя уже есть доступ мастера." });
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim().slice(0, 80);
  storage.createMasterRequest(user.id, name || "Мастер");
  const mainMaster = storage.getMainMaster();
  if (mainMaster && config.telegramBotToken) {
    void sendTelegramMessage(config.telegramBotToken, mainMaster.telegramId,
      `Новая заявка на доступ мастера: ${name || "Мастер"}.`).catch((error) => console.error("Не удалось сообщить о заявке мастера:", error.message));
  }
  res.status(201).json({ status: "pending" });
});

app.get("/api/master-requests/me", requireTelegramUser, (req, res) => {
  const request = storage.getMasterRequest(req.session.telegramUser.id);
  res.json({ status: request?.status ?? null });
});

app.post("/api/bookings", requireTelegramUser, bookingLimiter, upload.array("photos", 3), async (req, res) => {
  const master = storage.getMaster(String(req.body?.masterId ?? ""));
  const startsAt = Number(req.body?.startsAt);
  const customerName = String(req.body?.customerName || [req.session.telegramUser.firstName, req.session.telegramUser.lastName].filter(Boolean).join(" ")).trim();
  const phone = String(req.body?.phone ?? "").trim();
  const description = String(req.body?.description ?? "").trim();
  if (!master?.active) return res.status(400).json({ error: "Выбери доступного мастера." });
  if (!customerName || customerName.length > 80) return res.status(400).json({ error: "Укажи имя (до 80 символов)." });
  const telegramUsername = String(req.session.telegramUser.username ?? "").replace(/^@/, "");
  if (!telegramUsername && !phone) return res.status(400).json({ error: "Укажи номер телефона, чтобы мастер мог связаться с тобой." });
  if (phone && !/^[+\d()\s.-]{5,30}$/.test(phone)) return res.status(400).json({ error: "Проверь номер телефона." });
  if (description.length > 1200) return res.status(400).json({ error: "Описание должно быть короче 1200 символов." });
  const slot = findAvailableSlot(master, startsAt);
  if (!slot) return res.status(409).json({ error: "Это время уже недоступно. Обнови список свободного времени." });

  const files = req.files ?? [];
  const extensions = files.map((file) => detectImage(file.buffer));
  if (extensions.some((extension) => !extension)) {
    return res.status(400).json({ error: "Поддерживаются только фотографии JPEG, PNG и WebP." });
  }

  const savedFiles = [];
  try {
    await fs.mkdir(config.uploadsPath, { recursive: true });
    for (const extension of extensions) {
      const filename = `${randomUUID()}.${extension}`;
      const filePath = path.join(config.uploadsPath, filename);
      await fs.writeFile(filePath, files[savedFiles.length].buffer, { flag: "wx", mode: 0o600 });
      savedFiles.push(filename);
    }
    const booking = storage.createBooking({
      masterId: master.id,
      masterName: master.name,
      userId: Number(req.session.telegramUser.id),
      telegramUsername,
      customerName,
      phone,
      startsAt: slot.start.toMillis(),
      endsAt: slot.end.toMillis(),
      createdAt: Date.now(),
      description,
      photosJson: JSON.stringify(savedFiles),
      createdByMasterId: null,
      source: "client",
    });
    if (!booking) {
      await Promise.all(savedFiles.map((filename) => fs.rm(path.join(config.uploadsPath, filename), { force: true })));
      return res.status(409).json({ error: "Это время только что заняли. Выбери другой слот." });
    }
    void notifyMaster(master, {
      startsAt: booking.startsAt,
      customerName,
      phone,
      telegramUsername,
      description,
      photoCount: savedFiles.length,
    }).catch((error) => console.error("Не удалось отправить уведомление мастеру в Telegram:", error.message));
    res.status(201).json({ bookingId: booking.id });
  } catch (error) {
    await Promise.all(savedFiles.map((filename) => fs.rm(path.join(config.uploadsPath, filename), { force: true })));
    throw error;
  }
});

app.get("/api/master/schedule", requireMaster, (req, res) => {
  const today = DateTime.now().setZone(config.timezone).startOf("day");
  res.json({
    dailyStart: req.master.dailyStart,
    dailyEnd: req.master.dailyEnd,
    blocks: storage.listAvailabilityBlocks(
      req.master.id,
      today.toISODate(),
      today.plus({ days: config.bookingHorizonDays - 1 }).toISODate(),
    ),
  });
});

app.patch("/api/master/schedule", requireMaster, (req, res) => {
  const dailyStart = String(req.body?.dailyStart ?? "");
  const dailyEnd = String(req.body?.dailyEnd ?? "");
  const startMinute = minuteOfDay(dailyStart);
  const endMinute = minuteOfDay(dailyEnd);
  if (startMinute === null || endMinute === null || endMinute <= startMinute) {
    return res.status(400).json({ error: "Укажи корректные часы начала и конца с шагом 30 минут." });
  }
  const conflicts = storage.listUpcomingBookings(req.master.id).filter((booking) => {
    const start = DateTime.fromMillis(booking.starts_at, { zone: config.timezone });
    const end = DateTime.fromMillis(booking.ends_at, { zone: config.timezone });
    const startOfDay = start.hour * 60 + start.minute;
    const endOfDay = end.hour * 60 + end.minute;
    return startOfDay < startMinute || endOfDay > endMinute;
  });
  storage.updateMasterSchedule(req.master.id, dailyStart, dailyEnd);
  res.json({
    dailyStart,
    dailyEnd,
    affectedBookings: conflicts.map((booking) => publicBooking(booking)),
  });
});

app.post("/api/master/availability-blocks", requireMaster, (req, res) => {
  const date = String(req.body?.date ?? "");
  if (!isDateWithinHorizon(date, config.timezone)) {
    return res.status(400).json({ error: "Выбери дату в ближайшие 14 дней." });
  }
  let startMinute = null;
  let endMinute = null;
  if (!req.body?.allDay) {
    startMinute = minuteOfDay(req.body?.startTime);
    endMinute = minuteOfDay(req.body?.endTime);
    const dailyStart = minuteOfDay(req.master.dailyStart);
    const dailyEnd = minuteOfDay(req.master.dailyEnd);
    if (startMinute === null || endMinute === null || startMinute >= endMinute
      || startMinute < dailyStart || endMinute > dailyEnd) {
      return res.status(400).json({ error: "Выбери корректный интервал внутри рабочего времени." });
    }
  }
  const dayStart = DateTime.fromISO(date, { zone: config.timezone }).startOf("day");
  const conflictStart = startMinute === null ? dayStart : dayStart.plus({ minutes: startMinute });
  const conflictEnd = endMinute === null ? dayStart.plus({ days: 1 }) : dayStart.plus({ minutes: endMinute });
  const conflicts = storage.getBookingsOverlapping(req.master.id, conflictStart.toMillis(), conflictEnd.toMillis());
  const blockId = storage.createAvailabilityBlock(req.master.id, date, startMinute, endMinute);
  res.status(201).json({
    blockId,
    affectedBookings: conflicts.map((booking) => publicBooking(booking)),
  });
});

app.delete("/api/master/availability-blocks/:id", requireMaster, (req, res) => {
  const blockId = Number(req.params.id);
  if (!Number.isSafeInteger(blockId) || !storage.deleteAvailabilityBlock(req.master.id, blockId)) {
    return res.status(404).json({ error: "Нерабочий период не найден." });
  }
  res.json({ ok: true });
});

app.get("/api/main/overview", requireMainMaster, (_req, res) => {
  const masters = storage.listMasters(false).map((master) => ({
    ...master,
    upcomingBookings: master.isMain ? [] : storage.listUpcomingBookings(master.id).map((booking) => publicBooking(booking)),
    historyCount: master.active ? 0 : storage.countMasterBookings(master.id),
    history: master.active ? [] : storage.listMasterBookings(master.id, 10, 0).map((booking) => publicBooking(booking)),
  }));
  res.json({ requests: storage.listMasterRequests(), masters });
});

app.post("/api/main/requests/:telegramId/approve", requireMainMaster, async (req, res) => {
  const telegramId = String(req.params.telegramId);
  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  if (!/^\d{1,20}$/.test(telegramId) || !name) return res.status(400).json({ error: "Проверь имя мастера." });
  const master = storage.approveMasterRequest(telegramId, name, randomUUID());
  if (!master) return res.status(404).json({ error: "Заявка уже обработана или не найдена." });
  if (config.telegramBotToken) {
    void sendTelegramMessage(config.telegramBotToken, telegramId, "Заявка одобрена. Тебе доступен кабинет мастера в приложении.")
      .catch((error) => console.error("Не удалось сообщить об одобрении заявки:", error.message));
  }
  res.json({ master });
});

app.post("/api/main/requests/:telegramId/reject", requireMainMaster, (req, res) => {
  const telegramId = String(req.params.telegramId);
  if (!/^\d{1,20}$/.test(telegramId) || !storage.rejectMasterRequest(telegramId)) {
    return res.status(404).json({ error: "Заявка уже обработана или не найдена." });
  }
  res.json({ ok: true });
});

app.post("/api/main/masters/:id/deactivate", requireMainMaster, (req, res) => {
  const result = storage.deactivateMaster(req.params.id);
  if (result.kind === "bookings") {
    return res.status(409).json({ error: `Сначала перенеси или отмени будущие записи: ${result.count}.` });
  }
  if (result.kind !== "ok") return res.status(404).json({ error: "Мастера нельзя отключить или он уже отключён." });
  res.json({ ok: true });
});

app.post("/api/main/bookings/:id/transfer", requireMainMaster, async (req, res) => {
  const bookingId = Number(req.params.id);
  const targetMaster = storage.getMaster(String(req.body?.masterId ?? ""));
  const startsAt = Number(req.body?.startsAt);
  if (!targetMaster?.active || targetMaster.id === storage.getBooking(bookingId)?.master_id) {
    return res.status(400).json({ error: "Выбери другого доступного мастера." });
  }
  const slot = findAvailableSlot(targetMaster, startsAt);
  if (!slot) return res.status(409).json({ error: "Это время у выбранного мастера недоступно." });
  const result = storage.transferBooking(bookingId, targetMaster, slot.start.toMillis(), slot.end.toMillis());
  if (result.kind === "missing") return res.status(404).json({ error: "Будущая запись не найдена." });
  if (result.kind === "not_future") return res.status(409).json({ error: "Можно переносить только будущие записи." });
  if (result.kind === "conflict") return res.status(409).json({ error: "Это время уже заняли. Выбери другой слот." });
  if (result.kind === "inactive") return res.status(409).json({ error: "Выбранный мастер уже отключён." });
  let notificationSent = false;
  try {
    notificationSent = await notifyCustomerBookingMoved(result.booking, targetMaster, slot.start.toMillis());
  } catch (error) {
    console.error("Не удалось уведомить клиента о переносе:", error.message);
  }
  res.json({ ok: true, notificationSent });
});

app.post("/api/main/bookings/:id/cancel", requireMainMaster, async (req, res) => {
  const booking = storage.getBooking(Number(req.params.id));
  if (!booking || booking.status !== "active") return res.status(404).json({ error: "Активная запись не найдена." });
  storage.cancelBooking(booking.id);
  let notificationSent = false;
  try {
    notificationSent = await notifyCustomerBookingCancelled(booking);
  } catch (error) {
    console.error("Не удалось сообщить клиенту об отмене:", error.message);
  }
  res.json({ ok: true, notificationSent });
});

app.get("/api/master/bookings", requireMaster, (req, res) => {
  const limit = 10;
  const total = storage.countMasterBookings(req.master.id);
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(1, Number.parseInt(req.query.page ?? "1", 10) || 1), pages);
  const bookings = storage.listMasterBookings(req.master.id, limit, (page - 1) * limit);
  res.json({
    bookings: bookings.map((booking) => publicBooking(booking, true)),
    page,
    pages,
    total,
  });
});

app.get("/api/master/bookings/:id", requireMaster, (req, res) => {
  const booking = storage.getMasterBooking(req.master.id, Number(req.params.id));
  if (!booking) return res.status(404).json({ error: "Запись не найдена." });
  res.json({ booking: publicBooking(booking, true) });
});

app.get("/api/master/bookings/:id/photos/:index", requireMaster, (req, res, next) => {
  const booking = storage.getMasterBooking(req.master.id, Number(req.params.id));
  const index = Number(req.params.index);
  const files = booking ? JSON.parse(booking.photos_json || "[]") : [];
  if (!booking || !Number.isInteger(index) || !files[index]) return res.sendStatus(404);
  res.setHeader("Cache-Control", "private, no-store");
  res.sendFile(path.join(config.uploadsPath, files[index]), (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.post("/api/master/bookings/:id/reschedule", requireMaster, async (req, res) => {
  const bookingId = Number(req.params.id);
  const current = storage.getMasterBooking(req.master.id, bookingId);
  if (!current || current.status !== "active") return res.status(404).json({ error: "Активная запись не найдена." });
  const startsAt = Number(req.body?.startsAt);
  const slot = findAvailableSlot(req.master, startsAt, bookingId);
  if (!slot) return res.status(409).json({ error: "Выбери свободное время в ближайшие 14 дней." });
  const moved = storage.rescheduleBooking(req.master.id, bookingId, slot.start.toMillis(), slot.end.toMillis());
  if (moved.kind === "conflict") return res.status(409).json({ error: "Это время только что заняли. Выбери другой слот." });
  if (moved.kind !== "ok") return res.status(404).json({ error: "Активная запись не найдена." });
  let notificationSent = false;
  try {
    notificationSent = await notifyCustomerBookingMoved(moved.booking, req.master, slot.start.toMillis());
  } catch (error) {
    console.error("Не удалось уведомить клиента о переносе:", error.message);
  }
  res.json({ ok: true, notificationSent, dateLabel: slot.start.toFormat("dd.LL.yyyy"), timeLabel: slot.start.toFormat("HH:mm") });
});

app.post("/api/master/bookings", requireMaster, (req, res) => {
  const startsAt = Number(req.body?.startsAt);
  const slot = findAvailableSlot(req.master, startsAt);
  if (!slot) return res.status(409).json({ error: "Это время уже недоступно. Выбери другой слот." });
  const booking = storage.createBooking({
    masterId: req.master.id,
    masterName: req.master.name,
    userId: null,
    telegramUsername: "",
    customerName: "",
    phone: "",
    startsAt: slot.start.toMillis(),
    endsAt: slot.end.toMillis(),
    createdAt: Date.now(),
    description: "",
    photosJson: "[]",
    createdByMasterId: req.master.id,
    source: "master",
  });
  if (!booking) return res.status(409).json({ error: "Это время только что заняли." });
  res.status(201).json({ bookingId: booking.id });
});

app.post("/api/master/bookings/:id/cancel", requireMaster, async (req, res) => {
  const booking = storage.getMasterBooking(req.master.id, Number(req.params.id));
  if (!booking) return res.status(404).json({ error: "Запись не найдена." });
  if (booking.status !== "active") return res.status(409).json({ error: "Эта запись уже отменена." });
  storage.cancelMasterBooking(req.master.id, booking.id);
  let notificationSent = false;
  try { notificationSent = await notifyCustomerBookingCancelled(booking); }
  catch (error) { console.error("Не удалось сообщить клиенту об отмене:", error.message); }
  res.json({ ok: true, notificationSent });
});

app.delete("/api/master/bookings/:id", requireMaster, async (req, res) => {
  const booking = storage.getMasterBooking(req.master.id, Number(req.params.id));
  if (!booking) return res.status(404).json({ error: "Запись не найдена." });
  const files = JSON.parse(booking.photos_json || "[]");
  storage.deleteMasterBooking(req.master.id, booking.id);
  await Promise.all(files.map((filename) => fs.rm(path.join(config.uploadsPath, filename), { force: true })));
  res.json({ ok: true });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Такого действия нет." }));
app.use(express.static(path.join(projectRoot, "public"), { index: "index.html" }));
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(projectRoot, "public/index.html"));
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "Каждое фото должно быть меньше 5 МБ."
      : "Можно приложить не больше трёх фото.";
    return res.status(400).json({ error: message });
  }
  console.error(error);
  res.status(500).json({ error: "Не удалось выполнить запрос. Попробуй ещё раз." });
});

const server = app.listen(config.port, process.env.HOST ?? "0.0.0.0", () => {
  console.log(`${config.salonName}: http://localhost:${config.port}`);
});
const telegramBot = startTelegramBot(config, storage);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => {
      telegramBot.stop();
      sessions.close();
      storage.close();
    });
  });
}
