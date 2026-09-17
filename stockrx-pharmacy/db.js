const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'pharmacy.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS medicines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  reorder_level INTEGER NOT NULL DEFAULT 10,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  batch_no TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  expiry_date TEXT NOT NULL, -- ISO yyyy-mm-dd
  status TEXT NOT NULL DEFAULT 'active', -- active | quarantined
  flagged INTEGER NOT NULL DEFAULT 0, -- expiring within 7 days
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  message TEXT NOT NULL,
  in_date_stock INTEGER NOT NULL,
  reorder_level INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sim_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_date TEXT NOT NULL
);
`);

// seed simulated clock to real today if empty
const row = db.prepare('SELECT * FROM sim_clock WHERE id = 1').get();
if (!row) {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT INTO sim_clock (id, current_date) VALUES (1, ?)').run(today);
}

function getCurrentDate() {
  return db.prepare('SELECT current_date FROM sim_clock WHERE id = 1').get().current_date;
}

function setCurrentDate(d) {
  db.prepare('UPDATE sim_clock SET current_date = ? WHERE id = 1').run(d);
}

module.exports = { db, getCurrentDate, setCurrentDate };
