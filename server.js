const express = require('express');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('node:path');
const Database = require('./database');

const EXAM_DURATION_SECONDS = 120 * 60;
const EXAM_DEADLINE = Date.parse('2026-10-09T21:00:00+03:00');
const EXAM_DEADLINE_LABEL = '09.10.2026 21:00';
const app = express();
app.locals.examDeadline = EXAM_DEADLINE;
const db = new Database();
const isProduction = process.env.NODE_ENV === 'production';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const pdfFontPath = path.join(__dirname, 'public', 'fonts', 'NotoSans-Variable.ttf');

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (isProduction && (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET)) {
  throw new Error('Production requires ADMIN_PASSWORD and SESSION_SECRET environment variables.');
}

const sessionOptions = {
  secret: process.env.SESSION_SECRET || 'degistir-bu-gizli-anahtar',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  },
};
if (db.isPostgres) {
  const PgSession = connectPgSimple(session);
  sessionOptions.store = new PgSession({
    pool: db.pool,
    tableName: 'sessions',
    createTableIfMissing: true,
  });
}
app.use(session(sessionOptions));

const ADMIN = process.env.ADMIN_PASSWORD || 'admin123';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function emailKey(email) {
  let [local, domain] = String(email).trim().toLowerCase().split('@');
  local = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

function normalizeParticipantName(name) {
  return String(name).trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR');
}

function parseReview(reviewJson) {
  if (!reviewJson) return [];
  const review = JSON.parse(reviewJson);
  if (!Array.isArray(review)) {
    throw new Error('Stored exam review is not a valid question list.');
  }
  return review;
}

function getRemainingExamSeconds(startedAt, now = Date.now()) {
  return Math.max(0, Math.ceil((startedAt + EXAM_DURATION_SECONDS * 1000 - now) / 1000));
}

function isExamClosedAt(now, deadline = EXAM_DEADLINE) {
  return now >= deadline;
}

function isExamClosed(now = Date.now()) {
  return isExamClosedAt(now, app.locals.examDeadline);
}

function renderLogin(res, error = null) {
  return res.render('login', {
    error,
    examClosed: isExamClosed(),
    deadlineLabel: EXAM_DEADLINE_LABEL,
  });
}

function requireExam(req, res, next) {
  if (!req.session.exam) return res.redirect('/');
  next();
}

function requirePendingExam(req, res, next) {
  if (!req.session.pendingExam) return res.redirect('/');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect('/admin/login');
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get('/healthz', asyncRoute(async (req, res) => {
  await db.get('SELECT 1 AS ok');
  res.status(200).json({ status: 'ok' });
}));

app.get('/', (req, res) => renderLogin(res));
app.post('/start', asyncRoute(async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  if (!name || !email) return renderLogin(res, 'Ad Soyad ve E-posta adresi zorunludur.');
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return renderLogin(res, 'Geçerli bir e-posta adresi girin.');
  }

  const key = emailKey(email);
  const previousResult = await db.get(
    'SELECT id,name,email,score,correct,wrong,blank,duration,review_json FROM results WHERE email_key=?',
    [key],
  );
  if (previousResult) {
    if (normalizeParticipantName(previousResult.name) !== normalizeParticipantName(name)) {
      return renderLogin(res, 'Bu e-posta adresiyle kayıt bulunamadı. Ad soyad ve e-posta adresinizi kontrol edin.');
    }
    delete req.session.exam;
    delete req.session.pendingExam;
    req.session.result = {
      ...previousResult,
      review: parseReview(previousResult.review_json),
    };
    return res.redirect('/result');
  }
  if (isExamClosed()) {
    return renderLogin(res, 'Sınav giriş süresi sona erdi. Yeni sınav başlatılamaz; sıralamayı görüntüleyebilirsiniz.');
  }
  if (req.session.exam?.emailKey === key) return res.redirect('/exam');
  if (req.session.pendingExam?.emailKey === key) return res.redirect('/instructions');
  delete req.session.result;
  req.session.pendingExam = { name, email, emailKey: key };
  res.redirect('/instructions');
}));

app.get('/instructions', requirePendingExam, (req, res) => {
  res.render('instructions', { name: req.session.pendingExam.name });
});

app.post('/exam/start', requirePendingExam, (req, res) => {
  if (isExamClosed()) {
    delete req.session.pendingExam;
    return renderLogin(res, 'Sınav giriş süresi sona erdi. Yeni sınav başlatılamaz; sıralamayı görüntüleyebilirsiniz.');
  }
  const pendingExam = req.session.pendingExam;
  delete req.session.pendingExam;
  req.session.exam = { ...pendingExam, started: Date.now(), answers: {} };
  res.redirect('/exam');
});

app.get('/exam', requireExam, asyncRoute(async (req, res) => {
  const questions = await db.all('SELECT id,question,a,b,c,d,e FROM questions ORDER BY id');
  res.render('exam', {
    questions,
    name: req.session.exam.name,
    answers: req.session.exam.answers,
    remainingSeconds: getRemainingExamSeconds(req.session.exam.started),
  });
}));

app.post('/submit', requireExam, asyncRoute(async (req, res) => {
  const exam = req.session.exam;
  const answers = req.body.answers || {};
  let correct = 0;
  let wrong = 0;
  let blank = 0;
  const duration = Math.min(
    EXAM_DURATION_SECONDS,
    Math.max(0, Math.round((Date.now() - exam.started) / 1000)),
  );

  try {
    const result = await db.transaction(async (tx) => {
      const questions = await tx.all('SELECT * FROM questions ORDER BY id');
      if (await tx.get('SELECT id FROM results WHERE email_key=?', [exam.emailKey])) {
        return null;
      }
      const review = [];
      for (const question of questions) {
        const answer = answers[`q${question.id}`];
        if (!answer) blank++;
        else if (answer === question.answer) correct++;
        else wrong++;
        review.push({
          question: question.question,
          options: ['A', 'B', 'C', 'D', 'E'].map((option) => ({
            label: option,
            text: question[option.toLowerCase()],
          })),
          selectedAnswer: ['A', 'B', 'C', 'D', 'E'].includes(answer) ? answer : null,
          correctAnswer: question.answer,
        });
      }
      const savedResult = await tx.run(
        'INSERT INTO results(name,email,email_key,score,correct,wrong,blank,duration,review_json) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id',
        [
          exam.name,
          exam.email,
          exam.emailKey,
          correct,
          correct,
          wrong,
          blank,
          duration,
          JSON.stringify(review),
        ],
      );
      return { ...savedResult, review };
    });

    if (!result) {
      delete req.session.exam;
      return res.status(409).send('Bu e-posta ile sınav daha önce tamamlanmış.');
    }
    req.session.result = {
      id: result.lastInsertRowid,
      name: exam.name,
      email: exam.email,
      score: correct,
      correct,
      wrong,
      blank,
      duration,
      review: result.review,
    };
    delete req.session.exam;
    res.redirect('/result');
  } catch (error) {
    if (/UNIQUE/i.test(String(error.message))) {
      delete req.session.exam;
      return res.status(409).send('Bu e-posta ile sınav daha önce tamamlanmış.');
    }
    throw error;
  }
}));

app.get('/result', asyncRoute(async (req, res) => {
  if (!req.session.result) return res.redirect('/');
  const result = req.session.result;
  const ranking = await db.get(
    'SELECT COUNT(*)+1 AS rank FROM results WHERE score>? OR (score=? AND id<?)',
    [result.score, result.score, result.id],
  );
  res.render('result', {
    r: result,
    rank: ranking.rank,
    showRank: isExamClosed(),
    hasReview: result.review.length > 0,
  });
}));

app.get('/leaderboard', asyncRoute(async (req, res) => {
  if (!isExamClosed()) return res.redirect('/');
  const results = await db.all(
    'SELECT id,name,score,correct,wrong,blank,duration,created_at FROM results ORDER BY score DESC, duration ASC, id ASC',
  );
  const rows = results.map((row) => {
    const nameParts = row.name.trim().split(/\s+/).filter(Boolean);
    return {
      ...row,
      displayName: nameParts.map((part) => `${Array.from(part).slice(0, 2).join('')}***`).join(' '),
      isCurrent: req.session.result && String(row.id) === String(req.session.result.id),
    };
  });
  const currentRank = rows.findIndex((row) => row.isCurrent) + 1;
  res.render('leaderboard', {
    rows,
    currentRank: currentRank || null,
    hasResult: Boolean(req.session.result),
  });
}));

app.get('/result/pdf', (req, res) => {
  if (!req.session.result) return res.redirect('/');
  const result = req.session.result;
  if (!result.review.length) {
    return res.status(410).send('Bu eski sınav sonucu oluşturulurken sorular ve verilen cevaplar kaydedilmediğinden PDF cevap dökümü oluşturulamıyor.');
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="sinav-sorulari-ve-cevap-anahtari.pdf"');
  const doc = new PDFDocument({ margin: 45 });
  doc.pipe(res);
  function drawWatermark() {
    const { width, height } = doc.page;
    const cursor = { x: doc.x, y: doc.y };
    for (const y of [height * 0.25, height * 0.5, height * 0.75]) {
      const x = width / 2;
      doc.save()
        .fillColor('#d71920')
        .fillOpacity(0.16)
        .font(pdfFontPath)
        .fontSize(62)
        .rotate(-35, { origin: [x, y] })
        .text('JSPSPLUS', x - 140, y - 31, { width: 280, align: 'center', lineBreak: false })
        .restore();
    }
    doc.x = cursor.x;
    doc.y = cursor.y;
  }
  doc.on('pageAdded', drawWatermark);
  drawWatermark();
  doc.font(pdfFontPath);
  doc.fontSize(20).text('SINAV SORULARI VE CEVAP RAPORU', { align: 'center' }).moveDown();
  doc.fontSize(11)
    .text(`Katılımcı: ${result.name}`)
    .text(`E-posta: ${result.email}`)
    .text(`Puan: ${result.score}/100   Doğru: ${result.correct}   Yanlış: ${result.wrong}   Boş: ${result.blank}`)
    .moveDown();
  result.review.forEach((question, index) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 115) doc.addPage();
    doc.font(pdfFontPath);
    doc.fontSize(12).text(`${index + 1}. ${question.question}`);
    question.options.forEach((option) => {
      doc.fontSize(10).text(`${option.label}) ${option.text}`);
    });
    doc.fontSize(10)
      .text(`Sizin cevabınız: ${question.selectedAnswer || 'Boş'}`)
      .text(`Doğru cevap: ${question.correctAnswer}`)
      .text(!question.selectedAnswer
        ? 'Sonuç: Boş'
        : question.selectedAnswer === question.correctAnswer ? 'Sonuç: Doğru' : 'Sonuç: Yanlış');
    doc.moveDown(0.4);
  });
  doc.addPage();
  doc.font(pdfFontPath).fontSize(18).text('CEVAP ANAHTARI', { align: 'center' }).moveDown();
  result.review.forEach((question, index) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      doc.font(pdfFontPath).fontSize(14).text('CEVAP ANAHTARI (DEVAM)').moveDown();
    }
    doc.font(pdfFontPath).fontSize(10)
      .text(`${index + 1}. ${question.correctAnswer}  |  Sizin cevabınız: ${question.selectedAnswer || 'Boş'}`);
  });
  doc.end();
});

app.get('/admin/login', (req, res) => res.render('admin-login', { error: null }));
app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN) {
    req.session.admin = true;
    return res.redirect('/admin');
  }
  res.render('admin-login', { error: 'Şifre hatalı.' });
});

app.get('/admin', requireAdmin, asyncRoute(async (req, res) => {
  const [questions, rows] = await Promise.all([
    db.all('SELECT * FROM questions ORDER BY id'),
    db.all('SELECT * FROM results ORDER BY score DESC,duration ASC,id ASC'),
  ]);
  res.render('admin', {
    questions,
    rows,
    error: req.query.error || null,
    success: req.query.success || null,
  });
}));

app.post('/admin/question/:id', requireAdmin, asyncRoute(async (req, res) => {
  const { question, a, b, c, d, e, answer } = req.body;
  if (!['A', 'B', 'C', 'D', 'E'].includes(answer)) return res.status(400).send('Geçersiz cevap');
  await db.run(
    'UPDATE questions SET question=?,a=?,b=?,c=?,d=?,e=?,answer=? WHERE id=?',
    [question, a, b, c, d, e, answer, req.params.id],
  );
  res.redirect('/admin#questions');
}));

app.post('/admin/result/:id/delete', requireAdmin, asyncRoute(async (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).send('Geçersiz sonuç numarası.');
  }
  const result = await db.run('DELETE FROM results WHERE id=?', [req.params.id]);
  if (!result.changes) {
    return res.redirect('/admin?error=Silinecek+sonuç+bulunamadı.#results');
  }
  res.redirect('/admin?success=Katılımcı+sonucu+silindi.+Aynı+e-posta+adresiyle+yeniden+sınava+girebilir.#results');
}));

app.post('/admin/import-questions', requireAdmin, upload.single('excel'), asyncRoute(async (req, res) => {
  if (!req.file) return res.redirect('/admin?error=Excel+dosyası+seçilmedi#questions');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(req.file.buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return res.redirect('/admin?error=Excel+dosyası+boş#questions');
  const headers = worksheet.getRow(1).values.slice(1).map((value) => String(value || '').trim());
  const rows = [];
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const values = worksheet.getRow(rowNumber).values.slice(1);
    if (values.every((value) => value === null || value === undefined || value === '')) continue;
    rows.push(Object.fromEntries(headers.map((header, index) => [
      header,
      worksheet.getRow(rowNumber).getCell(index + 1).text,
    ])));
  }
  if (rows.length !== 100) {
    return res.redirect(`/admin?error=Excel+dosyasında+tam+olarak+100+soru+olmalı.+Bulunan%3A+${rows.length}#questions`);
  }
  const required = ['Soru', 'A', 'B', 'C', 'D', 'E', 'DogruCevap'];
  for (const column of required) {
    if (!(column in rows[0])) {
      return res.redirect(`/admin?error=Eksik+sütun%3A+${encodeURIComponent(column)}#questions`);
    }
  }
  const cleaned = rows.map((row) => ({
    question: String(row.Soru).trim(),
    a: String(row.A).trim(),
    b: String(row.B).trim(),
    c: String(row.C).trim(),
    d: String(row.D).trim(),
    e: String(row.E).trim(),
    answer: String(row.DogruCevap).trim().toUpperCase(),
  }));
  for (const [index, question] of cleaned.entries()) {
    if (!question.question || !question.a || !question.b || !question.c || !question.d || !question.e
      || !['A', 'B', 'C', 'D', 'E'].includes(question.answer)) {
      return res.redirect(`/admin?error=${encodeURIComponent(`${index + 2}. satır hatalı. Soru/5 seçenek/DoğruCevap (A-E) doldurulmalı.`)}#questions`);
    }
  }

  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM questions');
    for (const [index, question] of cleaned.entries()) {
      await tx.run(
        'INSERT INTO questions(id,question,a,b,c,d,e,answer) VALUES(?,?,?,?,?,?,?,?)',
        [index + 1, question.question, question.a, question.b, question.c, question.d, question.e, question.answer],
      );
    }
  });
  if (db.isPostgres) {
    await db.run(
      "SELECT setval(pg_get_serial_sequence('questions', 'id'), COALESCE((SELECT MAX(id) FROM questions), 1))",
    );
  }
  res.redirect('/admin?success=100+soru+başarıyla+aktarıldı.#questions');
}));

app.get('/admin/questions-template', requireAdmin, asyncRoute(async (req, res) => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    No: index + 1,
    Soru: `Soru ${index + 1}`,
    A: 'A seçeneği',
    B: 'B seçeneği',
    C: 'C seçeneği',
    D: 'D seçeneği',
    E: 'E seçeneği',
    DogruCevap: 'A',
  }));
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Sorular');
  worksheet.columns = Object.keys(rows[0]).map((key) => ({ header: key, key }));
  worksheet.addRows(rows);
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="sinav-soru-sablonu-100-soru.xlsx"');
  res.end(buffer);
}));

app.get('/admin/export-results', requireAdmin, asyncRoute(async (req, res) => {
  const rows = await db.all(
    'SELECT name AS "Ad Soyad",email AS "E-posta",score AS "Puan",correct AS "Doğru",wrong AS "Yanlış",blank AS "Boş",duration AS "Süre (sn)",created_at AS "Tarih" FROM results ORDER BY score DESC,duration ASC,id ASC',
  );
  const output = rows.map((row, index) => ({ ...row, Sıra: index + 1 }));
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Sonuçlar');
  if (output.length) {
    worksheet.columns = Object.keys(output[0]).map((key) => ({ header: key, key }));
    worksheet.addRows(output);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="sinav-sonuclari.xlsx"');
  res.end(buffer);
}));

app.post('/admin/reset-results', requireAdmin, asyncRoute(async (req, res) => {
  await db.run('DELETE FROM results');
  res.redirect('/admin#results');
}));
app.post('/admin/logout', requireAdmin, (req, res) => {
  req.session.admin = false;
  res.redirect('/');
});

app.use((error, req, res, next) => {
  console.error('Request failed:', error);
  if (res.headersSent) return next(error);
  res.status(500).send('İşlem sırasında bir hata oluştu. Lütfen tekrar deneyin.');
});

async function start() {
  await db.initialize();
  if ((await db.get('SELECT COUNT(*) AS count FROM questions')).count === 0) {
    await db.transaction(async (tx) => {
      for (let index = 1; index <= 100; index++) {
        await tx.run(
          'INSERT INTO questions(question,a,b,c,d,e,answer) VALUES(?,?,?,?,?,?,?)',
          [
            `Örnek Soru ${index}: Bu sorunun içeriğini yönetici panelinden kendi sınav sorunuzla değiştirebilirsiniz.`,
            'A seçeneği',
            'B seçeneği',
            'C seçeneği',
            'D seçeneği',
            'E seçeneği',
            ['A', 'B', 'C', 'D', 'E'][index % 5],
          ],
        );
      }
    });
  }

  const port = Number(process.env.PORT ?? 3000);
  return app.listen(port, () => {
    console.log(`Sınav uygulaması: http://localhost:${port}`);
    if (!isProduction) {
      if (!process.env.ADMIN_PASSWORD) console.warn('UYARI: Varsayılan yönetici şifresi (admin123) kullanılıyor!');
      if (!process.env.SESSION_SECRET) console.warn('UYARI: Varsayılan oturum anahtarı kullanılıyor!');
    }
  });
}

if (require.main === module) {
  start().catch(async (error) => {
    console.error('Uygulama başlatılamadı:', error);
    await db.close();
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  db,
  start,
  getRemainingExamSeconds,
  EXAM_DURATION_SECONDS,
  EXAM_DEADLINE,
  EXAM_DEADLINE_LABEL,
  isExamClosedAt,
};
