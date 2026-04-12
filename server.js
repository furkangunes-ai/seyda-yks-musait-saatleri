require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const backup = require('./backup');

const app = express();
const PORT = process.env.PORT || 3000;

// Veritabanını seed'le
db.seedSlots();
db.seedCategories();

// Başlangıçta geçmiş günleri temizle
db.autoResetPastDays();

// Başlangıçta bugünkü yedek yoksa oluştur + eski yedekleri temizle
try {
  backup.ensureTodayBackup();
  backup.cleanOldBackups(60);
} catch (e) {
  console.error('Backup başlangıç hatası:', e);
}

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' && process.env.RAILWAY_ENVIRONMENT ? true : false,
    maxAge: 24 * 60 * 60 * 1000 // 1 gün
  }
}));

// Flash mesaj helper
app.use((req, res, next) => {
  res.locals.success = req.session.success;
  res.locals.error = req.session.error;
  delete req.session.success;
  delete req.session.error;
  next();
});

// Trust proxy (Railway arkasında)
app.set('trust proxy', 1);

// Her istekte geçmiş günleri otomatik temizle
app.use((req, res, next) => {
  db.autoResetPastDays();
  next();
});

// ==========================================
// ÖĞRETMEN ROTALARI
// ==========================================

// Ana sayfa - bilgilendirme
app.get('/', (req, res) => {
  res.render('home');
});

// Öğretmen özel linki ile giriş
app.get('/t/:token', (req, res) => {
  const teacher = db.getTeacherByToken(req.params.token);

  if (!teacher) {
    return res.status(404).render('home', { error: 'Geçersiz link. Lütfen size verilen linki kontrol edin.' });
  }

  const grid = db.getSlotsGrid();

  res.render('teacher', {
    teacher,
    grid,
    DAYS: db.DAYS,
    DAYS_DISPLAY: db.DAYS_DISPLAY,
    HOURS: db.HOURS
  });
});

// Öğretmen ders rezerve etsin
app.post('/book', (req, res) => {
  const { day, start_time, token, description } = req.body;

  const teacher = db.getTeacherByToken(token);
  if (!teacher) {
    return res.status(403).send('Geçersiz erişim.');
  }

  if (!day || !start_time) {
    req.session.error = 'Lütfen bir saat seçin.';
    return res.redirect('/t/' + token);
  }

  const note = (description || '').trim();
  const label = teacher.subject ? `Özel Ders - ${teacher.subject}` : 'Özel Ders';
  const fullDesc = note ? `${label} (${note})` : label;

  const success = db.bookSlot(day, start_time, teacher.name, fullDesc);

  if (success) {
    req.session.success = `${db.DAYS_DISPLAY[day]} ${start_time} saati başarıyla onaylandı.`;
  } else {
    req.session.error = 'Bu saat zaten dolu. Lütfen başka bir saat seçin.';
  }

  res.redirect('/t/' + token);
});

// ==========================================
// ADMİN ROTALARI
// ==========================================

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

// Admin giriş sayfası
app.get('/admin/login', (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin');
  res.render('admin-login');
});

// Admin giriş işlemi
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'seyda123';

  // Timing-safe karşılaştırma
  const inputBuf = Buffer.from(password || '');
  const correctBuf = Buffer.from(adminPassword);

  if (inputBuf.length === correctBuf.length && crypto.timingSafeEqual(inputBuf, correctBuf)) {
    req.session.isAdmin = true;
    req.session.success = 'Hoş geldin Şeyda!';
    return res.redirect('/admin');
  }

  req.session.error = 'Yanlış şifre.';
  res.redirect('/admin/login');
});

// Admin panel
app.get('/admin', requireAdmin, (req, res) => {
  const grid = db.getSlotsGrid();
  const stats = db.getStats();
  const teachers = db.getAllTeachers();
  const categories = db.getAllCategories();

  res.render('admin', {
    grid,
    stats,
    teachers,
    categories,
    DAYS: db.DAYS,
    DAYS_DISPLAY: db.DAYS_DISPLAY,
    HOURS: db.HOURS,
    host: req.get('host'),
    protocol: req.protocol
  });
});

// Admin: slot blokla
app.post('/admin/block', requireAdmin, (req, res) => {
  const { day, start_time, description, custom_description, recurring } = req.body;
  const finalDesc = (description === '__custom__' ? custom_description : description) || 'Meşgul';
  const isRecurring = recurring === '1';

  const success = db.blockSlot(day, start_time, finalDesc, isRecurring);

  if (success) {
    const typeLabel = isRecurring ? ' (sabit - her hafta)' : '';
    req.session.success = `${db.DAYS_DISPLAY[day]} ${start_time} bloklandı${typeLabel}.`;
  } else {
    req.session.error = 'Slot bulunamadı.';
  }

  res.redirect('/admin');
});

// Admin: slot serbest bırak
app.post('/admin/free', requireAdmin, (req, res) => {
  const { day, start_time } = req.body;

  const success = db.freeSlot(day, start_time);

  if (success) {
    req.session.success = `${db.DAYS_DISPLAY[day]} ${start_time} serbest bırakıldı.`;
  } else {
    req.session.error = 'Slot bulunamadı.';
  }

  res.redirect('/admin');
});

// Admin: öğretmen ekle
app.post('/admin/teacher/add', requireAdmin, (req, res) => {
  const { name, subject } = req.body;

  if (!name || !name.trim()) {
    req.session.error = 'Öğretmen adı boş olamaz.';
    return res.redirect('/admin');
  }

  const teacher = db.addTeacher(name.trim(), subject);
  const subjectText = teacher.subject ? ` (${teacher.subject})` : '';
  req.session.success = `"${teacher.name}${subjectText}" eklendi.`;
  res.redirect('/admin');
});

// Admin: öğretmen sil
app.post('/admin/teacher/delete', requireAdmin, (req, res) => {
  const { id } = req.body;

  if (db.deleteTeacher(id)) {
    req.session.success = 'Öğretmen silindi.';
  } else {
    req.session.error = 'Öğretmen bulunamadı.';
  }

  res.redirect('/admin');
});

// Admin: kategori ekle
app.post('/admin/category/add', requireAdmin, (req, res) => {
  const { name } = req.body;

  if (!name || !name.trim()) {
    req.session.error = 'Kategori adı boş olamaz.';
    return res.redirect('/admin');
  }

  try {
    db.addCategory(name.trim());
    req.session.success = `"${name.trim()}" kategorisi eklendi.`;
  } catch (e) {
    req.session.error = 'Bu kategori zaten mevcut.';
  }

  res.redirect('/admin');
});

// Admin: kategori sil
app.post('/admin/category/delete', requireAdmin, (req, res) => {
  const { id } = req.body;

  if (db.deleteCategory(id)) {
    req.session.success = 'Kategori silindi.';
  } else {
    req.session.error = 'Kategori bulunamadı.';
  }

  res.redirect('/admin');
});

// ==========================================
// DENEME SINAVI ROTALARI
// ==========================================

// Admin: denemeler sayfası
app.get('/admin/denemeler', requireAdmin, (req, res) => {
  const { exam_type, scope, subject } = req.query;
  const allExams = db.getAllExams();
  const filtered = (exam_type || scope || subject)
    ? db.getExamsByFilter(exam_type, scope, subject)
    : [];
  const stats = db.getExamStats();

  res.render('admin-denemeler', {
    exams: allExams,
    filtered,
    filter: { exam_type: exam_type || '', scope: scope || '', subject: subject || '' },
    stats,
    EXAM_STRUCTURE: db.EXAM_STRUCTURE
  });
});

// Admin: deneme ekle
app.post('/admin/denemeler/add', requireAdmin, (req, res) => {
  const { exam_date, exam_type, scope, subject, correct, wrong, empty, notes, breakdown } = req.body;

  if (!exam_date || !exam_type || !scope || !subject) {
    req.session.error = 'Lütfen tarih, sınav türü, kapsam ve ders/alan alanlarını doldurun.';
    return res.redirect('/admin/denemeler');
  }

  // Breakdown varsa (composite deneme): alt dersleri topla + alt kayıtlar oluştur
  if (breakdown && typeof breakdown === 'object' && Object.keys(breakdown).length > 0) {
    let totalC = 0, totalW = 0, totalE = 0;
    const subItems = [];

    for (const subName of Object.keys(breakdown)) {
      const b = breakdown[subName];
      const c = parseInt(b.correct) || 0;
      const w = parseInt(b.wrong) || 0;
      const e = parseInt(b.empty) || 0;
      if (c < 0 || w < 0 || e < 0) {
        req.session.error = 'Negatif değer girilemez.';
        return res.redirect('/admin/denemeler');
      }
      totalC += c;
      totalW += w;
      totalE += e;
      subItems.push({ name: subName, correct: c, wrong: w, empty: e });
    }

    // Ana (composite) kayıt
    const parentResult = db.addExam({
      exam_date, exam_type, scope, subject,
      correct: totalC, wrong: totalW, empty: totalE,
      notes
    });
    const parentId = parentResult.lastInsertRowid;

    // Alt dersler için ayrı kayıtlar (scope: 'Alt Branş')
    // parent_id ile ana kayda bağlanır, böylece tam eşleşme garanti
    for (const s of subItems) {
      db.addExam({
        exam_date,
        exam_type,
        scope: 'Alt Branş',
        subject: s.name,
        correct: s.correct, wrong: s.wrong, empty: s.empty,
        notes: `${subject} denemesi içinden`,
        parent_id: parentId
      });
    }

    req.session.success = `${exam_type} ${subject} denemesi eklendi (${subItems.length} alt ders ile).`;
    return res.redirect('/admin/denemeler');
  }

  // Normal (tek ders) deneme
  const c = parseInt(correct) || 0;
  const w = parseInt(wrong) || 0;
  const e = parseInt(empty) || 0;

  if (c < 0 || w < 0 || e < 0) {
    req.session.error = 'Doğru/yanlış/boş sayıları negatif olamaz.';
    return res.redirect('/admin/denemeler');
  }

  db.addExam({ exam_date, exam_type, scope, subject, correct: c, wrong: w, empty: e, notes });
  req.session.success = `${exam_type} ${subject} denemesi eklendi.`;
  res.redirect('/admin/denemeler');
});

// Admin: deneme sil
app.post('/admin/denemeler/delete', requireAdmin, (req, res) => {
  const { id } = req.body;
  if (db.deleteExam(id)) {
    req.session.success = 'Deneme sonucu silindi.';
  } else {
    req.session.error = 'Deneme bulunamadı.';
  }
  res.redirect('/admin/denemeler');
});

// ==========================================
// YEDEKLEME ROTALARI
// ==========================================

// Admin: yedekler sayfası
app.get('/admin/backups', requireAdmin, (req, res) => {
  // Admin sayfası yüklenirken günlük yedek yoksa oluştur
  try { backup.ensureTodayBackup(); } catch (e) { console.error(e); }

  const backups = backup.listBackups();
  const stats = backup.getBackupStats();
  res.render('admin-backups', { backups, stats });
});

// Admin: manuel yedek oluştur
app.post('/admin/backups/create', requireAdmin, (req, res) => {
  try {
    const info = backup.createBackup(true);
    req.session.success = `Yedek oluşturuldu: ${info.filename} (${info.counts.exam_results} deneme, ${info.counts.teachers} öğretmen).`;
  } catch (e) {
    console.error(e);
    req.session.error = 'Yedek oluşturulurken hata: ' + e.message;
  }
  res.redirect('/admin/backups');
});

// Admin: yedeği indir
app.get('/admin/backups/download/:filename', requireAdmin, (req, res) => {
  try {
    const content = backup.getBackupContent(req.params.filename);
    if (!content) return res.status(404).send('Yedek bulunamadı.');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
    res.send(content);
  } catch (e) {
    res.status(400).send('Geçersiz dosya: ' + e.message);
  }
});

// Admin: yedek sil
app.post('/admin/backups/delete', requireAdmin, (req, res) => {
  try {
    if (backup.deleteBackup(req.body.filename)) {
      req.session.success = 'Yedek silindi.';
    } else {
      req.session.error = 'Yedek bulunamadı.';
    }
  } catch (e) {
    req.session.error = 'Silme hatası: ' + e.message;
  }
  res.redirect('/admin/backups');
});

// Admin: anlık DB'yi JSON olarak indir (yedek kaydetmeden)
app.get('/admin/backups/export-now', requireAdmin, (req, res) => {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const data = db.exportAllData();
  const exportObj = {
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
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="anlik-export-${dateStr}.json"`);
  res.send(JSON.stringify(exportObj, null, 2));
});

// Admin çıkış
app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Sunucuyu başlat
app.listen(PORT, () => {
  console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor`);
});
