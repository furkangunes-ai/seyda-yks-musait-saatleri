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

// Ana sayfa - Öğretmen girişi
app.get('/', (req, res) => {
  const teacherName = req.query.name || '';
  const grid = db.getSlotsGrid();

  res.render('teacher', {
    teacherName,
    grid,
    DAYS: db.DAYS,
    DAYS_DISPLAY: db.DAYS_DISPLAY,
    HOURS: db.HOURS
  });
});

// Öğretmen ders rezerve etsin
app.post('/book', (req, res) => {
  const { day, start_time, teacher_name, description } = req.body;

  if (!day || !start_time || !teacher_name || !teacher_name.trim()) {
    req.session.error = 'Lütfen tüm alanları doldurun.';
    return res.redirect('/?name=' + encodeURIComponent(teacher_name || ''));
  }

  const trimmedName = teacher_name.trim();
  const trimmedDesc = (description || '').trim();

  const success = db.bookSlot(day, start_time, trimmedName, trimmedDesc || trimmedName + ' dersi');

  if (success) {
    req.session.success = `${db.DAYS_DISPLAY[day]} ${start_time} saati başarıyla rezerve edildi.`;
  } else {
    req.session.error = 'Bu saat zaten dolu. Lütfen başka bir saat seçin.';
  }

  res.redirect('/?name=' + encodeURIComponent(trimmedName));
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

  res.render('admin', {
    grid,
    stats,
    DAYS: db.DAYS,
    DAYS_DISPLAY: db.DAYS_DISPLAY,
    HOURS: db.HOURS
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
