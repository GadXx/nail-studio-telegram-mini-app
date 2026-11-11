import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const mapMaster = (row) => row && ({
  id: row.id,
  telegramId: row.telegram_id,
  name: row.name,
  active: Boolean(row.active),
  isMain: Boolean(row.is_main),
  dailyStart: row.daily_start,
  dailyEnd: row.daily_end,
});

export class BookingStorage {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();

    this.findConflicts = this.db.prepare(`
      SELECT 1 FROM bookings
      WHERE master_id = @masterId AND status = 'active'
        AND id != COALESCE(@ignoreBookingId, -1)
        AND starts_at < @endsAt AND ends_at > @startsAt
      LIMIT 1
    `);
    this.insertBooking = this.db.prepare(`
      INSERT INTO bookings
        (master_id, master_name, user_id, telegram_username, customer_name, phone, starts_at, ends_at, created_at,
         description, photos_json, status, cancelled_at, created_by_master_id, source)
      VALUES
        (@masterId, @masterName, @userId, @telegramUsername, @customerName, @phone, @startsAt, @endsAt, @createdAt,
         @description, @photosJson, 'active', NULL, @createdByMasterId, @source)
    `);
    this.insertIfAvailable = this.db.transaction((booking) => {
      const masterIsActive = this.db.prepare("SELECT 1 FROM masters WHERE id = ? AND active = 1").get(booking.masterId);
      if (!masterIsActive) return null;
      if (this.findConflicts.get({ ...booking, ignoreBookingId: null })) return null;
      const result = this.insertBooking.run(booking);
      return { id: Number(result.lastInsertRowid), ...booking, status: "active" };
    });
  }

  migrate() {
    const columns = this.db.prepare("PRAGMA table_info(bookings)").all();
    if (columns.length === 0) {
      this.createBookingsTable();
    } else {
      const byName = new Map(columns.map((column) => [column.name, column]));
      if (byName.get("user_id")?.notnull) {
        this.migrateTelegramBookings(byName);
      } else {
        const additions = [
          ["description", "TEXT NOT NULL DEFAULT ''"],
          ["photos_json", "TEXT NOT NULL DEFAULT '[]'"],
          ["status", "TEXT NOT NULL DEFAULT 'active'"],
          ["cancelled_at", "INTEGER"],
          ["created_by_master_id", "TEXT"],
          ["source", "TEXT NOT NULL DEFAULT 'client'"],
        ];
        for (const [name, definition] of additions) {
          if (!byName.has(name)) this.db.exec(`ALTER TABLE bookings ADD COLUMN ${name} ${definition}`);
        }
      }
    }

    const bookingColumns = new Set(this.db.prepare("PRAGMA table_info(bookings)").all().map((column) => column.name));
    if (!bookingColumns.has("telegram_username")) {
      this.db.exec("ALTER TABLE bookings ADD COLUMN telegram_username TEXT NOT NULL DEFAULT ''");
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_bookings_master_time
        ON bookings(master_id, starts_at, ends_at);
      CREATE INDEX IF NOT EXISTS idx_bookings_master_status_time
        ON bookings(master_id, status, starts_at);
      CREATE TABLE IF NOT EXISTS masters (
        id TEXT PRIMARY KEY,
        telegram_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        is_main INTEGER NOT NULL DEFAULT 0,
        daily_start TEXT NOT NULL DEFAULT '10:00',
        daily_end TEXT NOT NULL DEFAULT '20:00',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS master_requests (
        telegram_id TEXT PRIMARY KEY,
        requested_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        decided_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS availability_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        master_id TEXT NOT NULL,
        date TEXT NOT NULL,
        start_minute INTEGER,
        end_minute INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_availability_blocks_master_date
        ON availability_blocks(master_id, date);
    `);
  }

  seedMasters(masters) {
    if (this.db.prepare("SELECT COUNT(*) AS count FROM masters").get().count > 0) return;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO masters
        (id, telegram_id, name, active, is_main, daily_start, daily_end, created_at)
      VALUES (@id, @telegramId, @name, 1, @isMain, '10:00', '20:00', @createdAt)
    `);
    const seed = this.db.transaction(() => {
      masters.forEach((master, index) => {
        if (!master.telegramId) return;
        insert.run({
          id: String(master.id),
          telegramId: String(master.telegramId),
          name: master.name,
          isMain: index === 0 ? 1 : 0,
          createdAt: Date.now(),
        });
      });
    });
    seed.immediate();
  }

  createBookingsTable() {
    this.db.exec(`
      CREATE TABLE bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        master_id TEXT NOT NULL,
        master_name TEXT NOT NULL,
        user_id INTEGER,
        telegram_username TEXT NOT NULL DEFAULT '',
        customer_name TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        starts_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        photos_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        cancelled_at INTEGER,
        created_by_master_id TEXT,
        source TEXT NOT NULL DEFAULT 'client'
      );
    `);
  }

  migrateTelegramBookings(columns) {
    const has = (name) => columns.has(name);
    const select = [
      "id",
      "master_id",
      "master_name",
      has("user_id") ? "user_id" : "NULL",
      has("telegram_username") ? "COALESCE(telegram_username, '')" : "''",
      has("customer_name") ? "COALESCE(customer_name, '')" : "''",
      has("phone") ? "COALESCE(phone, '')" : "''",
      "starts_at",
      "ends_at",
      "created_at",
      has("description") ? "COALESCE(description, '')" : "''",
      has("photos_json") ? "COALESCE(photos_json, '[]')" : "'[]'",
      has("status") ? "COALESCE(status, 'active')" : "'active'",
      has("cancelled_at") ? "cancelled_at" : "NULL",
      has("created_by_master_id") ? "created_by_master_id" : "NULL",
      has("source") ? "COALESCE(source, 'client')" : "'client'",
    ].join(", ");
    const migrate = this.db.transaction(() => {
      this.db.exec("ALTER TABLE bookings RENAME TO bookings_telegram_legacy");
      this.createBookingsTable();
      this.db.exec(`
        INSERT INTO bookings
          (id, master_id, master_name, user_id, telegram_username, customer_name, phone, starts_at, ends_at, created_at,
           description, photos_json, status, cancelled_at, created_by_master_id, source)
        SELECT ${select} FROM bookings_telegram_legacy;
        DROP TABLE bookings_telegram_legacy;
      `);
    });
    migrate.immediate();
  }

  listMasters(activeOnly = true) {
    const rows = this.db.prepare(`SELECT * FROM masters ${activeOnly ? "WHERE active = 1" : ""} ORDER BY is_main DESC, name COLLATE NOCASE`).all();
    return rows.map(mapMaster);
  }

  getMaster(masterId) {
    return mapMaster(this.db.prepare("SELECT * FROM masters WHERE id = ?").get(masterId));
  }

  getActiveMasterByTelegramId(telegramId) {
    return mapMaster(this.db.prepare("SELECT * FROM masters WHERE telegram_id = ? AND active = 1").get(String(telegramId)));
  }

  getMainMaster() {
    return mapMaster(this.db.prepare("SELECT * FROM masters WHERE is_main = 1 AND active = 1 LIMIT 1").get());
  }

  updateMasterSchedule(masterId, dailyStart, dailyEnd) {
    return this.db.prepare("UPDATE masters SET daily_start = ?, daily_end = ? WHERE id = ? AND active = 1")
      .run(dailyStart, dailyEnd, masterId).changes > 0;
  }

  createMasterRequest(telegramId, requestedName) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO master_requests (telegram_id, requested_name, status, created_at, decided_at)
      VALUES (?, ?, 'pending', ?, NULL)
      ON CONFLICT(telegram_id) DO UPDATE SET requested_name = excluded.requested_name,
        status = 'pending', created_at = excluded.created_at, decided_at = NULL
    `).run(String(telegramId), requestedName, now);
    return this.getMasterRequest(telegramId);
  }

  getMasterRequest(telegramId) {
    const row = this.db.prepare("SELECT * FROM master_requests WHERE telegram_id = ?").get(String(telegramId));
    return row && { telegramId: row.telegram_id, requestedName: row.requested_name, status: row.status, createdAt: row.created_at };
  }

  listMasterRequests() {
    return this.db.prepare("SELECT telegram_id, requested_name, status, created_at FROM master_requests WHERE status = 'pending' ORDER BY created_at")
      .all().map((row) => ({ telegramId: row.telegram_id, requestedName: row.requested_name, status: row.status, createdAt: row.created_at }));
  }

  approveMasterRequest(telegramId, name, id) {
    const request = this.db.prepare("SELECT * FROM master_requests WHERE telegram_id = ? AND status = 'pending'").get(String(telegramId));
    if (!request) return null;
    const approve = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO masters (id, telegram_id, name, active, is_main, daily_start, daily_end, created_at)
        VALUES (?, ?, ?, 1, 0, '10:00', '20:00', ?)
        ON CONFLICT(telegram_id) DO UPDATE SET name = excluded.name, active = 1
      `).run(id, String(telegramId), name, Date.now());
      this.db.prepare("UPDATE master_requests SET status = 'approved', decided_at = ? WHERE telegram_id = ?")
        .run(Date.now(), String(telegramId));
    });
    approve.immediate();
    return this.getActiveMasterByTelegramId(telegramId);
  }

  rejectMasterRequest(telegramId) {
    return this.db.prepare("UPDATE master_requests SET status = 'rejected', decided_at = ? WHERE telegram_id = ? AND status = 'pending'")
      .run(Date.now(), String(telegramId)).changes > 0;
  }

  countFutureActiveBookings(masterId, now = Date.now()) {
    return this.db.prepare("SELECT COUNT(*) AS count FROM bookings WHERE master_id = ? AND status = 'active' AND starts_at >= ?")
      .get(masterId, now).count;
  }

  deactivateMaster(masterId) {
    const deactivate = this.db.transaction(() => {
      const row = this.db.prepare("SELECT is_main, active FROM masters WHERE id = ?").get(masterId);
      if (!row || row.is_main || !row.active) return { kind: "missing" };
      const count = this.countFutureActiveBookings(masterId);
      if (count > 0) return { kind: "bookings", count };
      this.db.prepare("UPDATE masters SET active = 0 WHERE id = ?").run(masterId);
      return { kind: "ok" };
    });
    return deactivate.immediate();
  }

  listUpcomingBookings(masterId, now = Date.now()) {
    return this.db.prepare(`SELECT * FROM bookings WHERE master_id = ? AND status = 'active' AND starts_at >= ? ORDER BY starts_at`)
      .all(masterId, now);
  }

  getAvailabilityBlocks(masterId, date) {
    return this.db.prepare("SELECT * FROM availability_blocks WHERE master_id = ? AND date = ? ORDER BY start_minute")
      .all(masterId, date).map((row) => ({
        id: row.id,
        masterId: row.master_id,
        date: row.date,
        startMinute: row.start_minute,
        endMinute: row.end_minute,
      }));
  }

  listAvailabilityBlocks(masterId, fromDate, throughDate) {
    return this.db.prepare(`SELECT * FROM availability_blocks WHERE master_id = ? AND date >= ? AND date <= ? ORDER BY date, start_minute`)
      .all(masterId, fromDate, throughDate).map((row) => ({
        id: row.id,
        masterId: row.master_id,
        date: row.date,
        startMinute: row.start_minute,
        endMinute: row.end_minute,
      }));
  }

  createAvailabilityBlock(masterId, date, startMinute, endMinute) {
    const result = this.db.prepare(`
      INSERT INTO availability_blocks (master_id, date, start_minute, end_minute, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(masterId, date, startMinute, endMinute, Date.now());
    return Number(result.lastInsertRowid);
  }

  deleteAvailabilityBlock(masterId, blockId) {
    return this.db.prepare("DELETE FROM availability_blocks WHERE master_id = ? AND id = ?").run(masterId, blockId).changes > 0;
  }

  getBookedIntervals(masterId, startsAt, endsAt, ignoreBookingId = null) {
    return this.db.prepare(`
      SELECT starts_at, ends_at FROM bookings
      WHERE master_id = ? AND status = 'active' AND id != COALESCE(?, -1)
        AND starts_at < ? AND ends_at > ?
    `).all(masterId, ignoreBookingId, endsAt, startsAt);
  }

  getBookingsOverlapping(masterId, startsAt, endsAt) {
    return this.db.prepare(`
      SELECT * FROM bookings WHERE master_id = ? AND status = 'active'
        AND starts_at < ? AND ends_at > ? ORDER BY starts_at
    `).all(masterId, endsAt, startsAt);
  }

  createBooking(booking) {
    return this.insertIfAvailable.immediate(booking);
  }

  rescheduleBooking(masterId, bookingId, startsAt, endsAt) {
    const update = this.db.transaction(() => {
      const booking = this.db.prepare("SELECT * FROM bookings WHERE master_id = ? AND id = ? AND status = 'active'").get(masterId, bookingId);
      if (!booking) return { kind: "missing" };
      if (this.findConflicts.get({ masterId, startsAt, endsAt, ignoreBookingId: bookingId })) return { kind: "conflict" };
      this.db.prepare("UPDATE bookings SET starts_at = ?, ends_at = ? WHERE id = ?").run(startsAt, endsAt, bookingId);
      return { kind: "ok", booking: { ...booking, starts_at: startsAt, ends_at: endsAt } };
    });
    return update.immediate();
  }

  transferBooking(bookingId, newMaster, startsAt, endsAt) {
    const transfer = this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM masters WHERE id = ? AND active = 1").get(newMaster.id)) return { kind: "inactive" };
      const booking = this.db.prepare("SELECT * FROM bookings WHERE id = ? AND status = 'active'").get(bookingId);
      if (!booking) return { kind: "missing" };
      if (booking.starts_at < Date.now()) return { kind: "not_future" };
      if (this.findConflicts.get({ masterId: newMaster.id, startsAt, endsAt, ignoreBookingId: bookingId })) return { kind: "conflict" };
      this.db.prepare("UPDATE bookings SET master_id = ?, master_name = ?, starts_at = ?, ends_at = ? WHERE id = ?")
        .run(newMaster.id, newMaster.name, startsAt, endsAt, bookingId);
      return { kind: "ok", booking: { ...booking, master_id: newMaster.id, master_name: newMaster.name, starts_at: startsAt, ends_at: endsAt } };
    });
    return transfer.immediate();
  }

  listMasterBookings(masterId, limit, offset) {
    return this.db.prepare(`
      SELECT * FROM bookings
      WHERE master_id = ?
      ORDER BY CASE WHEN status = 'active' AND starts_at >= ? THEN 0 ELSE 1 END,
        CASE WHEN status = 'active' AND starts_at >= ? THEN starts_at END ASC,
        starts_at DESC
      LIMIT ? OFFSET ?
    `).all(masterId, Date.now(), Date.now(), limit, offset);
  }

  countMasterBookings(masterId) {
    return this.db.prepare("SELECT COUNT(*) AS count FROM bookings WHERE master_id = ?").get(masterId).count;
  }

  getMasterBooking(masterId, bookingId) {
    return this.db.prepare("SELECT * FROM bookings WHERE master_id = ? AND id = ?").get(masterId, bookingId);
  }

  getBooking(bookingId) {
    return this.db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
  }

  cancelMasterBooking(masterId, bookingId) {
    return this.db.prepare(`
      UPDATE bookings SET status = 'cancelled', cancelled_at = ?
      WHERE master_id = ? AND id = ? AND status = 'active'
    `).run(Date.now(), masterId, bookingId).changes > 0;
  }

  cancelBooking(bookingId) {
    return this.db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'active'")
      .run(Date.now(), bookingId).changes > 0;
  }

  deleteMasterBooking(masterId, bookingId) {
    return this.db.prepare("DELETE FROM bookings WHERE master_id = ? AND id = ?").run(masterId, bookingId).changes > 0;
  }

  close() {
    this.db.close();
  }
}
