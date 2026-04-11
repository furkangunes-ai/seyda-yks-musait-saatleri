const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'schedule.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Tablolar oluştur
db.exec(`
  CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS time_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    teacher_name TEXT,
    description TEXT,
    is_admin_blocked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(day, start_time)
  )
`);

const DAYS = ['Pazartesi', 'Sali', 'Carsamba', 'Persembe', 'Cuma', 'Cumartesi', 'Pazar'];

const DAYS_DISPLAY = {
  'Pazartesi': 'Pazartesi',
  'Sali': 'Salı',
  'Carsamba': 'Çarşamba',
  'Persembe': 'Perşembe',
  'Cuma': 'Cuma',
  'Cumartesi': 'Cumartesi',
  'Pazar': 'Pazar'
};

const HOURS = [
  '09:00', '10:00', '11:00', '12:00', '13:00', '14:00',
  '15:00', '16:00', '17:00', '18:00', '19:00', '20:00'
];

// Seed: 7 gün x 12 saat = 84 slot
function seedSlots() {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM time_slots').get().cnt;
  if (count > 0) return;

  const insert = db.prepare(`
    INSERT INTO time_slots (day, start_time, end_time, status, is_admin_blocked)
    VALUES (?, ?, ?, 'available', 0)
  `);

  const insertMany = db.transaction(() => {
    for (const day of DAYS) {
      for (let i = 0; i < HOURS.length; i++) {
        const startH = parseInt(HOURS[i]);
        const endTime = `${String(startH + 1).padStart(2, '0')}:00`;
        insert.run(day, HOURS[i], endTime);
      }
    }
  });

  insertMany();
}

// Tüm slotları getir
function getAllSlots() {
  return db.prepare('SELECT * FROM time_slots ORDER BY id').all();
}

// Grid formatında slotları getir
function getSlotsGrid() {
  const allSlots = getAllSlots();
  const grid = {};
  for (const slot of allSlots) {
    if (!grid[slot.day]) grid[slot.day] = {};
    grid[slot.day][slot.start_time] = slot;
  }
  return grid;
}

// Tek bir slot getir
function getSlot(day, startTime) {
  return db.prepare('SELECT * FROM time_slots WHERE day = ? AND start_time = ?').get(day, startTime);
}

// Öğretmen slot rezerve etsin
function bookSlot(day, startTime, teacherName, description) {
  const stmt = db.prepare(`
    UPDATE time_slots
    SET status = 'booked', teacher_name = ?, description = ?, is_admin_blocked = 0
    WHERE day = ? AND start_time = ? AND status = 'available'
  `);
  const result = stmt.run(teacherName, description, day, startTime);
  return result.changes > 0;
}

// Admin slot blokla
function blockSlot(day, startTime, description) {
  const stmt = db.prepare(`
    UPDATE time_slots
    SET status = 'blocked', description = ?, is_admin_blocked = 1, teacher_name = NULL
    WHERE day = ? AND start_time = ?
  `);
  const result = stmt.run(description, day, startTime);
  return result.changes > 0;
}

// Admin slot serbest bırak
function freeSlot(day, startTime) {
  const stmt = db.prepare(`
    UPDATE time_slots
    SET status = 'available', teacher_name = NULL, description = NULL, is_admin_blocked = 0
    WHERE day = ? AND start_time = ?
  `);
  const result = stmt.run(day, startTime);
  return result.changes > 0;
}

// İstatistikler
function getStats() {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available,
      SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END) as booked,
      SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked
    FROM time_slots
  `).get();
  return stats;
}

// ==========================================
// ÖĞRETMEN YÖNETİMİ
// ==========================================

function generateToken() {
  return crypto.randomBytes(6).toString('hex');
}

function addTeacher(name) {
  const token = generateToken();
  const stmt = db.prepare('INSERT INTO teachers (name, token) VALUES (?, ?)');
  stmt.run(name.trim(), token);
  return { name: name.trim(), token };
}

function getAllTeachers() {
  return db.prepare('SELECT * FROM teachers ORDER BY name').all();
}

function getTeacherByToken(token) {
  return db.prepare('SELECT * FROM teachers WHERE token = ?').get(token);
}

function deleteTeacher(id) {
  const stmt = db.prepare('DELETE FROM teachers WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

module.exports = {
  seedSlots,
  getAllSlots,
  getSlotsGrid,
  getSlot,
  bookSlot,
  blockSlot,
  freeSlot,
  getStats,
  addTeacher,
  getAllTeachers,
  getTeacherByToken,
  deleteTeacher,
  DAYS,
  DAYS_DISPLAY,
  HOURS
};
