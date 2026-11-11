import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import session from "express-session";

export class SQLiteSessionStore extends session.Store {
  constructor(databasePath) {
    super();
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    `);
    this.getStatement = this.db.prepare("SELECT sess, expires_at FROM sessions WHERE sid = ?");
    this.setStatement = this.db.prepare(`
      INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at
    `);
    this.deleteStatement = this.db.prepare("DELETE FROM sessions WHERE sid = ?");
    this.touchStatement = this.db.prepare("UPDATE sessions SET expires_at = ? WHERE sid = ?");
    this.cleanupTimer = setInterval(() => {
      this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
    }, 60 * 60 * 1000).unref();
  }

  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now()) {
        this.deleteStatement.run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const expiresAt = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 24 * 60 * 60 * 1000;
      this.setStatement.run(sid, JSON.stringify(sess), expiresAt);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    try {
      const expiresAt = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 24 * 60 * 60 * 1000;
      this.touchStatement.run(expiresAt, sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.deleteStatement.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
    this.db.close();
  }
}
