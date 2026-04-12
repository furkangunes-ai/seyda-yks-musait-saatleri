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
    subject TEXT NOT NULL DEFAULT '',
    token TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// subject sütunu yoksa ekle (mevcut veritabanları için)
try {
  db.exec(`ALTER TABLE teachers ADD COLUMN subject TEXT NOT NULL DEFAULT ''`);
} catch (e) {
  // sütun zaten var, sorun yok
}

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
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
    is_recurring INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(day, start_time)
  )
`);

// is_recurring sütunu yoksa ekle (mevcut veritabanları için)
try {
  db.exec(`ALTER TABLE time_slots ADD COLUMN is_recurring INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  // sütun zaten var
}

// Deneme sınavı sonuçları tablosu
db.exec(`
  CREATE TABLE IF NOT EXISTS exam_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_date TEXT NOT NULL,
    exam_type TEXT NOT NULL,
    scope TEXT NOT NULL,
    subject TEXT,
    correct INTEGER NOT NULL DEFAULT 0,
    wrong INTEGER NOT NULL DEFAULT 0,
    empty INTEGER NOT NULL DEFAULT 0,
    net REAL NOT NULL DEFAULT 0,
    notes TEXT,
    parent_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// parent_id sütunu yoksa ekle (eski veritabanları için)
try {
  db.exec(`ALTER TABLE exam_results ADD COLUMN parent_id INTEGER`);
} catch (e) {
  // sütun zaten var
}

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

// Öğretmen slot onayla (her zaman değişken - is_recurring = 0)
function bookSlot(day, startTime, teacherName, description) {
  const stmt = db.prepare(`
    UPDATE time_slots
    SET status = 'booked', teacher_name = ?, description = ?, is_admin_blocked = 0, is_recurring = 0
    WHERE day = ? AND start_time = ? AND status = 'available'
  `);
  const result = stmt.run(teacherName, description, day, startTime);
  return result.changes > 0;
}

// Admin slot blokla (sabit veya değişken)
function blockSlot(day, startTime, description, isRecurring) {
  const stmt = db.prepare(`
    UPDATE time_slots
    SET status = 'blocked', description = ?, is_admin_blocked = 1, teacher_name = NULL, is_recurring = ?
    WHERE day = ? AND start_time = ?
  `);
  const result = stmt.run(description, isRecurring ? 1 : 0, day, startTime);
  return result.changes > 0;
}

// Admin slot serbest bırak
function freeSlot(day, startTime) {
  const stmt = db.prepare(`
    UPDATE time_slots
    SET status = 'available', teacher_name = NULL, description = NULL, is_admin_blocked = 0, is_recurring = 0
    WHERE day = ? AND start_time = ?
  `);
  const result = stmt.run(day, startTime);
  return result.changes > 0;
}

// ==========================================
// HAFTALIK OTOMATİK TEMİZLEME
// ==========================================

function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

// Bir günün değişken (non-recurring) slotlarını temizle
function resetDaySlots(day) {
  const stmt = db.prepare(`
    UPDATE time_slots
    SET status = 'available', teacher_name = NULL, description = NULL, is_admin_blocked = 0
    WHERE day = ? AND is_recurring = 0 AND status != 'available'
  `);
  return stmt.run(day).changes;
}

// Geçmiş günleri otomatik temizle
function autoResetPastDays() {
  const now = new Date();
  // Pazartesi = 0, Pazar = 6 (Türk takvimi)
  const currentDayIndex = (now.getDay() + 6) % 7;
  const today = now.toISOString().split('T')[0];

  // Bu haftanın Pazartesi tarihini bul
  const monday = new Date(now);
  monday.setDate(now.getDate() - currentDayIndex);
  const mondayStr = monday.toISOString().split('T')[0];

  // Geçmiş günleri temizle (bugünden önceki günler)
  for (let i = 0; i < currentDayIndex; i++) {
    const day = DAYS[i];
    const lastReset = getMeta('last_reset_' + day);

    // Bu haftanın Pazartesisinden sonra temizlenmemişse temizle
    if (!lastReset || lastReset < mondayStr) {
      const cleared = resetDaySlots(day);
      setMeta('last_reset_' + day, today);
      if (cleared > 0) {
        console.log(`[Auto-Reset] ${DAYS_DISPLAY[day]}: ${cleared} değişken slot temizlendi.`);
      }
    }
  }
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

function addTeacher(name, subject) {
  const token = generateToken();
  const stmt = db.prepare('INSERT INTO teachers (name, subject, token) VALUES (?, ?, ?)');
  stmt.run(name.trim(), (subject || '').trim(), token);
  return { name: name.trim(), subject: (subject || '').trim(), token };
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

// ==========================================
// KATEGORİ YÖNETİMİ
// ==========================================

function seedCategories() {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM categories').get().cnt;
  if (count > 0) return;

  const defaults = ['Deneme Sınavı', 'Konu Tekrarı', 'Test Çözme'];
  const insert = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
  for (const name of defaults) {
    insert.run(name);
  }
}

function getAllCategories() {
  return db.prepare('SELECT * FROM categories ORDER BY name').all();
}

function addCategory(name) {
  const stmt = db.prepare('INSERT INTO categories (name) VALUES (?)');
  stmt.run(name.trim());
  return { name: name.trim() };
}

function deleteCategory(id) {
  const stmt = db.prepare('DELETE FROM categories WHERE id = ?');
  return stmt.run(id).changes > 0;
}

// ==========================================
// DENEME SINAVLARI
// ==========================================

// TYT/AYT sınav yapısı - Sayısal öğrencisi için hazırlandı
// Kapsamlar:
// - Genel: Tam deneme (tüm dersler bir arada, composite)
// - Alan: Büyük branş denemeleri (Türkçe, Matematik, Sosyal/Fen Bilimleri)
// - Tekil Ders: Öğrenci sadece tek bir dersin denemesini çözdüyse (Fizik, Kimya vb.)
const EXAM_STRUCTURE = {
  TYT: {
    Genel: [
      {
        name: 'Tam Deneme',
        total: 120,
        breakdown: [
          { name: 'Türkçe', total: 40 },
          { name: 'Matematik', total: 40 },
          { name: 'Sosyal Bilimler', total: 20 },
          { name: 'Fen Bilimleri', total: 20 }
        ]
      }
    ],
    Alan: [
      { name: 'Türkçe', total: 40 },
      { name: 'Matematik', total: 40 },
      {
        name: 'Sosyal Bilimler',
        total: 20,
        breakdown: [
          { name: 'Tarih', total: 5 },
          { name: 'Coğrafya', total: 5 },
          { name: 'Felsefe', total: 5 },
          { name: 'Din Kültürü', total: 5 }
        ]
      },
      {
        name: 'Fen Bilimleri',
        total: 20,
        breakdown: [
          { name: 'Fizik', total: 7 },
          { name: 'Kimya', total: 7 },
          { name: 'Biyoloji', total: 6 }
        ]
      }
    ],
    'Tekil Ders': [
      { name: 'Geometri', total: 10 },
      { name: 'Tarih', total: 5 },
      { name: 'Coğrafya', total: 5 },
      { name: 'Felsefe', total: 5 },
      { name: 'Din Kültürü', total: 5 },
      { name: 'Fizik', total: 7 },
      { name: 'Kimya', total: 7 },
      { name: 'Biyoloji', total: 6 }
    ]
  },
  AYT: {
    Genel: [
      {
        name: 'Sayısal Tam Deneme',
        total: 80,
        breakdown: [
          { name: 'Matematik', total: 40 },
          { name: 'Fizik', total: 14 },
          { name: 'Kimya', total: 13 },
          { name: 'Biyoloji', total: 13 }
        ]
      }
    ],
    Alan: [
      { name: 'Matematik', total: 40 },
      {
        name: 'Fen Bilimleri',
        total: 40,
        breakdown: [
          { name: 'Fizik', total: 14 },
          { name: 'Kimya', total: 13 },
          { name: 'Biyoloji', total: 13 }
        ]
      }
    ],
    'Tekil Ders': [
      { name: 'Geometri', total: 10 },
      { name: 'Fizik', total: 14 },
      { name: 'Kimya', total: 13 },
      { name: 'Biyoloji', total: 13 }
    ]
  }
};

function addExam(data) {
  const correct = parseInt(data.correct) || 0;
  const wrong = parseInt(data.wrong) || 0;
  const empty = parseInt(data.empty) || 0;
  const net = Math.max(0, correct - wrong / 4);

  const stmt = db.prepare(`
    INSERT INTO exam_results
      (exam_date, exam_type, scope, subject, correct, wrong, empty, net, notes, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    data.exam_date,
    data.exam_type,
    data.scope,
    data.subject || null,
    correct, wrong, empty, net,
    data.notes || null,
    data.parent_id || null
  );
}

function getAllExams() {
  return db.prepare('SELECT * FROM exam_results ORDER BY exam_date DESC, id DESC').all();
}

function getExamsByFilter(examType, scope, subject) {
  let query = 'SELECT * FROM exam_results WHERE 1=1';
  const params = [];
  if (examType) { query += ' AND exam_type = ?'; params.push(examType); }

  // 'Tekil Ders' filtresi = o ders adına ait tüm tekli kayıtlar
  // (hem standalone 'Tekil Ders' hem de composite içinden gelen 'Alt Branş')
  if (scope === 'Tekil Ders') {
    query += ' AND scope IN (?, ?)';
    params.push('Tekil Ders', 'Alt Branş');
  } else if (scope) {
    query += ' AND scope = ?';
    params.push(scope);
  }

  if (subject) { query += ' AND subject = ?'; params.push(subject); }
  query += ' ORDER BY exam_date ASC, id ASC';
  return db.prepare(query).all(...params);
}

function deleteExam(id) {
  // Cascade: önce çocuk kayıtları sil (parent_id = id olanlar)
  db.prepare('DELETE FROM exam_results WHERE parent_id = ?').run(id);
  return db.prepare('DELETE FROM exam_results WHERE id = ?').run(id).changes > 0;
}

function getExamStats() {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM exam_results').get().cnt;
  const lastExam = db.prepare('SELECT exam_date FROM exam_results ORDER BY exam_date DESC LIMIT 1').get();
  return {
    total,
    lastExamDate: lastExam ? lastExam.exam_date : null
  };
}

// ==========================================
// YEDEKLEME İÇİN VERİ DIŞA AKTARMA
// ==========================================

function exportAllData() {
  return {
    teachers: db.prepare('SELECT * FROM teachers').all(),
    categories: db.prepare('SELECT * FROM categories').all(),
    time_slots: db.prepare('SELECT * FROM time_slots').all(),
    meta: db.prepare('SELECT * FROM meta').all(),
    exam_results: db.prepare('SELECT * FROM exam_results').all()
  };
}

module.exports = {
  seedSlots,
  seedCategories,
  getAllSlots,
  getSlotsGrid,
  getSlot,
  bookSlot,
  blockSlot,
  freeSlot,
  getStats,
  autoResetPastDays,
  addTeacher,
  getAllTeachers,
  getTeacherByToken,
  deleteTeacher,
  getAllCategories,
  addCategory,
  deleteCategory,
  addExam,
  getAllExams,
  getExamsByFilter,
  deleteExam,
  getExamStats,
  exportAllData,
  EXAM_STRUCTURE,
  DAYS,
  DAYS_DISPLAY,
  HOURS
};
