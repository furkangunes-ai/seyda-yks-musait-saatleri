const fs = require('fs');
const path = require('path');
const db = require('./db');

// Yedekleme klasörü: DB ile aynı persistent konumda
// (Railway'de volume mount'lı /data klasöründe olmalı ki deploy'larda silinmesin)
function getBackupDir() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'schedule.db');
  const dir = path.join(path.dirname(dbPath), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Güvenlik: dosya adı sadece backup formatına uygun olmalı
const BACKUP_NAME_REGEX = /^backup-\d{4}-\d{2}-\d{2}(_\d{6})?\.json$/;

function isValidFilename(filename) {
  return typeof filename === 'string' && BACKUP_NAME_REGEX.test(filename);
}

// Manuel yedek oluştur (timestamp'li, gün içinde birden fazla olabilir)
function createBackup(manual = false) {
  const data = db.exportAllData();
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  let filename;

  if (manual) {
    // Saat de dahil: backup-2026-04-12_143022.json
    const timeStr = [
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0')
    ].join('');
    filename = `backup-${dateStr}_${timeStr}.json`;
  } else {
    filename = `backup-${dateStr}.json`;
  }

  const filepath = path.join(getBackupDir(), filename);

  const backup = {
    created_at: now.toISOString(),
    version: '1.0',
    record_counts: {
      teachers: data.teachers.length,
      categories: data.categories.length,
      time_slots: data.time_slots.length,
      exam_results: data.exam_results.length,
      meta: data.meta.length
    },
    data
  };

  fs.writeFileSync(filepath, JSON.stringify(backup, null, 2));
  const stat = fs.statSync(filepath);
  return {
    filename,
    size: stat.size,
    created_at: now.toISOString(),
    counts: backup.record_counts
  };
}

// Yedek listesini getir (en yeniden en eskiye)
function listBackups() {
  const dir = getBackupDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir)
    .filter(f => isValidFilename(f))
    .map(f => {
      const filepath = path.join(dir, f);
      const stat = fs.statSync(filepath);
      let counts = null;
      try {
        const content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        counts = content.record_counts || null;
      } catch (e) {
        // Bozuk dosya, sorun değil
      }
      return {
        filename: f,
        size: stat.size,
        created_at: stat.mtime.toISOString(),
        counts
      };
    })
    .sort((a, b) => b.filename.localeCompare(a.filename));

  return files;
}

// Yedek içeriğini oku (JSON string olarak)
function getBackupContent(filename) {
  if (!isValidFilename(filename)) throw new Error('Geçersiz dosya adı.');
  const filepath = path.join(getBackupDir(), filename);
  if (!fs.existsSync(filepath)) return null;
  return fs.readFileSync(filepath, 'utf8');
}

// Yedek sil
function deleteBackup(filename) {
  if (!isValidFilename(filename)) throw new Error('Geçersiz dosya adı.');
  const filepath = path.join(getBackupDir(), filename);
  if (!fs.existsSync(filepath)) return false;
  fs.unlinkSync(filepath);
  return true;
}

// Bugünkü yedek yoksa oluştur (otomatik günlük yedek)
function ensureTodayBackup() {
  const today = new Date().toISOString().split('T')[0];
  const filename = `backup-${today}.json`;
  const filepath = path.join(getBackupDir(), filename);
  if (fs.existsSync(filepath)) return null;
  return createBackup(false);
}

// Eski yedekleri temizle (default: 60 günden eski)
function cleanOldBackups(keepDays = 60) {
  const dir = getBackupDir();
  if (!fs.existsSync(dir)) return 0;

  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!isValidFilename(f)) continue;
    const filepath = path.join(dir, f);
    const stat = fs.statSync(filepath);
    if (stat.mtime.getTime() < cutoff) {
      fs.unlinkSync(filepath);
      deleted++;
    }
  }
  return deleted;
}

// Toplam yedek istatistikleri
function getBackupStats() {
  const backups = listBackups();
  const totalSize = backups.reduce((s, b) => s + b.size, 0);
  return {
    count: backups.length,
    totalSize,
    oldestDate: backups.length > 0 ? backups[backups.length - 1].created_at : null,
    newestDate: backups.length > 0 ? backups[0].created_at : null,
    backupDir: getBackupDir()
  };
}

module.exports = {
  createBackup,
  listBackups,
  getBackupContent,
  deleteBackup,
  ensureTodayBackup,
  cleanOldBackups,
  getBackupStats,
  isValidFilename
};
