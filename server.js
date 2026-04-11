require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Veritabanını seed'le
db.seedSlots();

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

  const trimmedDesc = (description || '').trim();

  const success = db.bookSlot(day, start_time, teacher.name, trimmedDesc || teacher.name + ' dersi');

  if (success) {
    req.session.success = `${db.DAYS_DISPLAY[day]} ${start_time} saati başarıyla rezerve edildi.`;
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

  res.render('admin', {
    grid,
    stats,
    teachers,
    DAYS: db.DAYS,
    DAYS_DISPLAY: db.DAYS_DISPLAY,
    HOURS: db.HOURS,
    host: req.get('host'),
    protocol: req.protocol
  });
});

// Admin: slot blokla
app.post('/admin/block', requireAdmin, (req, res) => {
  const { day, start_time, description } = req.body;

  const success = db.blockSlot(day, start_time, description || 'Meşgul');

  if (success) {
    req.session.success = `${db.DAYS_DISPLAY[day]} ${start_time} bloklandı.`;
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
  const { name } = req.body;

  if (!name || !name.trim()) {
    req.session.error = 'Öğretmen adı boş olamaz.';
    return res.redirect('/admin');
  }

  const teacher = db.addTeacher(name.trim());
  req.session.success = `"${teacher.name}" eklendi. Özel link: /t/${teacher.token}`;
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
