const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { db, getCurrentDate, setCurrentDate } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function inDateStock(medicineId, asOf) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(quantity),0) as qty FROM batches
     WHERE medicine_id = ? AND status = 'active' AND expiry_date >= ?`
  ).get(medicineId, asOf);
  return row.qty;
}

function medicineTotalStock(medicineId) {
  // all in-date, non-quarantined quantity regardless of flag
  return inDateStock(medicineId, getCurrentDate());
}

function checkReorder(medicineId) {
  const med = db.prepare('SELECT * FROM medicines WHERE id = ?').get(medicineId);
  if (!med) return;
  const stock = medicineTotalStock(medicineId);
  if (stock <= med.reorder_level) {
    const last = db.prepare(
      'SELECT * FROM outbox WHERE medicine_id = ? ORDER BY id DESC LIMIT 1'
    ).get(medicineId);
    if (!last || last.in_date_stock !== stock) {
      db.prepare(
        `INSERT INTO outbox (medicine_id, message, in_date_stock, reorder_level)
         VALUES (?, ?, ?, ?)`
      ).run(
        medicineId,
        `Re-order alert: ${med.name} in-date stock (${stock}) is at or below reorder level (${med.reorder_level}).`,
        stock,
        med.reorder_level
      );
    }
  }
}

function parseQty(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Math.round(parseFloat(m[0]));
  if (isNaN(n) || n <= 0) return null;
  return n;
}

function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // ISO yyyy-mm-dd
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // dd/mm/yyyy or dd-mm-yyyy
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (parseInt(mo) > 12) return null; // not a valid month, ambiguous garbage
    d = d.padStart(2, '0'); mo = mo.padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  // yyyy/mm/dd
  m = s.match(/^(\d{4})[\/](\d{1,2})[\/](\d{1,2})$/);
  if (m) {
    let [, y, mo, d] = m;
    d = d.padStart(2, '0'); mo = mo.padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return null;
}

// ---------- auth ----------
app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'Email already registered' });
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(name, email, hash);
  const token = jwt.sign({ id: info.lastInsertRowid, email, name }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: info.lastInsertRowid, name, email } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

// ---------- medicines ----------
app.get('/api/medicines', auth, (req, res) => {
  const { search = '', page = 1, pageSize = 10, sort = 'name', dir = 'asc' } = req.query;
  const allowedSort = ['name', 'reorder_level', 'created_at'];
  const sortCol = allowedSort.includes(sort) ? sort : 'name';
  const sortDir = dir === 'desc' ? 'DESC' : 'ASC';
  const p = Math.max(1, parseInt(page));
  const ps = Math.min(100, Math.max(1, parseInt(pageSize)));
  const offset = (p - 1) * ps;

  const total = db.prepare('SELECT COUNT(*) c FROM medicines WHERE name LIKE ?').get(`%${search}%`).c;
  const rows = db.prepare(
    `SELECT * FROM medicines WHERE name LIKE ? ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`
  ).all(`%${search}%`, ps, offset);

  const withStock = rows.map(m => ({ ...m, in_date_stock: inDateStock(m.id, getCurrentDate()) }));
  res.json({ data: withStock, total, page: p, pageSize: ps });
});

app.post('/api/medicines', auth, (req, res) => {
  const { name, reorder_level = 10 } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const info = db.prepare('INSERT INTO medicines (name, reorder_level) VALUES (?, ?)').run(name, reorder_level);
    res.json({ id: info.lastInsertRowid, name, reorder_level });
  } catch (e) {
    res.status(409).json({ error: 'Medicine already exists' });
  }
});

app.get('/api/medicines/:id/stock', auth, (req, res) => {
  const med = db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id);
  if (!med) return res.status(404).json({ error: 'Not found' });
  const stock = inDateStock(med.id, getCurrentDate());
  res.json({ medicine: med.name, in_date_stock: stock, in_date: stock > 0, as_of: getCurrentDate() });
});

// ---------- batches ----------
app.get('/api/batches', auth, (req, res) => {
  const { medicine_id, page = 1, pageSize = 10, sort = 'expiry_date', dir = 'asc', status } = req.query;
  const allowedSort = ['expiry_date', 'quantity', 'created_at', 'batch_no'];
  const sortCol = allowedSort.includes(sort) ? sort : 'expiry_date';
  const sortDir = dir === 'desc' ? 'DESC' : 'ASC';
  const p = Math.max(1, parseInt(page));
  const ps = Math.min(100, Math.max(1, parseInt(pageSize)));
  const offset = (p - 1) * ps;

  let where = '1=1';
  const params = [];
  if (medicine_id) { where += ' AND medicine_id = ?'; params.push(medicine_id); }
  if (status) { where += ' AND status = ?'; params.push(status); }

  const total = db.prepare(`SELECT COUNT(*) c FROM batches WHERE ${where}`).get(...params).c;
  const rows = db.prepare(
    `SELECT b.*, m.name as medicine_name FROM batches b JOIN medicines m ON m.id = b.medicine_id
     WHERE ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`
  ).all(...params, ps, offset);

  res.json({ data: rows, total, page: p, pageSize: ps });
});

app.post('/api/batches', auth, (req, res) => {
  const { medicine_id, batch_no, quantity, expiry_date } = req.body || {};
  if (!medicine_id || !batch_no || !quantity || !expiry_date) {
    return res.status(400).json({ error: 'medicine_id, batch_no, quantity, expiry_date required' });
  }
  const med = db.prepare('SELECT * FROM medicines WHERE id = ?').get(medicine_id);
  if (!med) return res.status(404).json({ error: 'Medicine not found' });
  const info = db.prepare(
    'INSERT INTO batches (medicine_id, batch_no, quantity, expiry_date) VALUES (?, ?, ?, ?)'
  ).run(medicine_id, batch_no, quantity, expiry_date);
  checkReorder(medicine_id);
  res.json({ id: info.lastInsertRowid });
});

// ---------- dispense (FEFO) ----------
app.post('/api/dispense', auth, (req, res) => {
  const { medicine_id, quantity } = req.body || {};
  const qty = parseInt(quantity);
  if (!medicine_id || !qty || qty <= 0) return res.status(400).json({ error: 'medicine_id and positive quantity required' });

  const today = getCurrentDate();
  const available = inDateStock(medicine_id, today);
  if (available < qty) {
    return res.status(400).json({ error: `Insufficient in-date stock. Available: ${available}` });
  }

  const batches = db.prepare(
    `SELECT * FROM batches WHERE medicine_id = ? AND status = 'active' AND expiry_date >= ?
     ORDER BY expiry_date ASC, id ASC`
  ).all(medicine_id, today);

  let remaining = qty;
  const used = [];
  const tx = db.transaction(() => {
    for (const b of batches) {
      if (remaining <= 0) break;
      const take = Math.min(b.quantity, remaining);
      db.prepare('UPDATE batches SET quantity = quantity - ? WHERE id = ?').run(take, b.id);
      used.push({ batch_id: b.id, batch_no: b.batch_no, taken: take, expiry_date: b.expiry_date });
      remaining -= take;
    }
  });
  tx();
  checkReorder(medicine_id);
  res.json({ dispensed: qty, from_batches: used });
});

// ---------- search (medicines + batches) ----------
app.get('/api/search', auth, (req, res) => {
  const q = req.query.q || '';
  const meds = db.prepare('SELECT * FROM medicines WHERE name LIKE ? LIMIT 20').all(`%${q}%`);
  const batches = db.prepare(
    `SELECT b.*, m.name as medicine_name FROM batches b JOIN medicines m ON m.id = b.medicine_id
     WHERE m.name LIKE ? OR b.batch_no LIKE ? LIMIT 20`
  ).all(`%${q}%`, `%${q}%`);
  res.json({ medicines: meds, batches });
});

// ---------- messy bulk import (Level 2 / T4) ----------
app.post('/api/import', auth, (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  let imported = 0, deduped = 0, rejected = 0;
  const rejectedDetails = [];
  const seen = new Set();

  const tx = db.transaction(() => {
    for (const raw of rows) {
      const name = (raw?.medicine_name ?? raw?.name ?? '').toString().trim();
      const batchNo = (raw?.batch_no ?? raw?.batch ?? '').toString().trim();
      const qty = parseQty(raw?.quantity);
      const exp = parseDate(raw?.expiry_date ?? raw?.expiry);

      if (!name || !batchNo || qty === null || exp === null) {
        rejected++;
        rejectedDetails.push({ row: raw, reason: !name ? 'missing medicine name' : !batchNo ? 'missing batch no' : qty === null ? 'unparseable quantity' : 'unparseable date' });
        continue;
      }

      const key = `${name.toLowerCase()}|${batchNo.toLowerCase()}|${qty}|${exp}`;
      if (seen.has(key)) { deduped++; continue; }
      seen.add(key);

      // dedupe against existing DB rows too (exact match)
      let med = db.prepare('SELECT * FROM medicines WHERE name = ?').get(name);
      if (!med) {
        const info = db.prepare('INSERT INTO medicines (name) VALUES (?)').run(name);
        med = { id: info.lastInsertRowid, name };
      }
      const existing = db.prepare(
        'SELECT id FROM batches WHERE medicine_id = ? AND batch_no = ? AND quantity = ? AND expiry_date = ?'
      ).get(med.id, batchNo, qty, exp);
      if (existing) { deduped++; continue; }

      db.prepare(
        'INSERT INTO batches (medicine_id, batch_no, quantity, expiry_date) VALUES (?, ?, ?, ?)'
      ).run(med.id, batchNo, qty, exp);
      imported++;
      checkReorder(med.id);
    }
  });
  tx();

  res.json({ imported, deduped, rejected, rejectedDetails });
});

// ---------- Level 1 / T2: POST /clock (unauthenticated, root-mounted) ----------
app.post('/clock', (req, res) => {
  const { date } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
  }
  setCurrentDate(date);

  // daily job: quarantine expired, flag expiring-within-7-days
  const sevenDaysOut = new Date(date);
  sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);
  const sevenIso = sevenDaysOut.toISOString().slice(0, 10);

  const expired = db.prepare(
    `SELECT * FROM batches WHERE status = 'active' AND expiry_date < ?`
  ).all(date);
  const quarantineTx = db.transaction(() => {
    for (const b of expired) {
      db.prepare('UPDATE batches SET status = ?, flagged = 0 WHERE id = ?').run('quarantined', b.id);
    }
  });
  quarantineTx();

  db.prepare(`UPDATE batches SET flagged = 0 WHERE status = 'active'`).run();
  const flaggedInfo = db.prepare(
    `UPDATE batches SET flagged = 1 WHERE status = 'active' AND expiry_date >= ? AND expiry_date <= ?`
  ).run(date, sevenIso);

  // re-check reorder alerts for all medicines affected by quarantine
  const affectedMeds = [...new Set(expired.map(b => b.medicine_id))];
  for (const mid of affectedMeds) checkReorder(mid);

  res.json({
    current_date: date,
    quarantined: expired.length,
    flagged_expiring_soon: flaggedInfo.changes,
  });
});

app.get('/clock', (req, res) => {
  res.json({ current_date: getCurrentDate() });
});

// ---------- Level 3 / T1: GET /outbox (unauthenticated, root-mounted) ----------
app.get('/outbox', (req, res) => {
  const rows = db.prepare(
    `SELECT o.*, m.name as medicine_name FROM outbox o JOIN medicines m ON m.id = o.medicine_id ORDER BY o.id DESC`
  ).all();
  res.json({ data: rows, total: rows.length });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pharmacy app running on http://localhost:${PORT}`));
