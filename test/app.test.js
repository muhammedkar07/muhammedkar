const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ExcelJS = require('exceljs');

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sinav-app-test-'));
process.env.SQLITE_PATH = path.join(testDirectory, 'exam.db');
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.PORT = '0';

const {
  app,
  db,
  start,
  getRemainingExamSeconds,
  EXAM_DURATION_SECONDS,
  EXAM_DEADLINE,
  EXAM_DEADLINE_LABEL,
  isExamClosedAt,
} = require('../server');

function sessionCookie(response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

test('exam countdown auto-submits when time runs out without a confirmation dialog', () => {
  const elements = {
    counter: { textContent: '' },
    timer: { textContent: '', dataset: { remainingSeconds: '1' } },
    prev: { disabled: false },
    next: { style: {} },
    finish: { disabled: false },
    exam: {
      requestSubmit() {
        this.submitted = true;
        this.onsubmitResult = this.onsubmit();
      },
    },
  };
  const questions = [{ classList: { toggle() {} } }];
  let interval;
  let confirmCalled = false;
  const context = {
    document: {
      querySelectorAll: () => questions,
      getElementById: (id) => elements[id],
    },
    confirm: () => {
      confirmCalled = true;
      return true;
    },
    setInterval: (callback) => {
      interval = callback;
      return 1;
    },
  };
  const examScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'exam.js'), 'utf8');
  vm.runInNewContext(examScript, context);
  assert.equal(elements.timer.textContent, '00:01');
  interval();
  assert.equal(elements.timer.textContent, '00:00');
  assert.equal(elements.exam.submitted, true);
  assert.equal(elements.exam.onsubmitResult, true);
  assert.equal(confirmCalled, false);
});

test('local SQLite exam, result, admin, and Excel workflows', async () => {
  const server = await start();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const home = await fetch(baseUrl);
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.ok(homeHtml.includes('<title>jspsplus Deneme Sınavı</title>'));
    assert.ok(homeHtml.includes('<h1>jspsplus Deneme Sınavı</h1>'));
    assert.ok(homeHtml.includes('Sıralama sonuçları Cuma günü saat 21.00\'de yayınlanacaktır.'));
    assert.match(homeHtml, /kaydınız yoksa sınav hakkında bilgilendirme ekranı açılır/i);
    assert.ok(homeHtml.includes('Önceki sınav sonucunuza erişmek için sınavda kullandığınız ad-soyadı ve aynı e-posta adresini doğru girin.'));
    assert.ok(homeHtml.includes('href="https://www.instagram.com/jspsplus"'));
    assert.match(homeHtml, /Sınavı teknik bir hata nedeniyle tamamlayamazsanız/);
    assert.ok(homeHtml.includes('<button>Devam et</button>'));
    assert.match(homeHtml, /trycloudflare\.com/);
    assert.ok(homeHtml.includes('Adresin <b>trycloudflare.com</b> ile bitmesi, sınav için kullanılan geçici yayın yöntemindendir.'));
    assert.match(homeHtml, /e-posta adresiniz herkese açık sıralamada gösterilmez/i);
    assert.doesNotMatch(homeHtml, /href="\/leaderboard"/);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM questions')).count, 100);
    const guestLeaderboard = await fetch(`${baseUrl}/leaderboard`, { redirect: 'manual' });
    assert.equal(guestLeaderboard.status, 302);
    assert.equal(guestLeaderboard.headers.get('location'), '/');
    const now = Date.now();
    assert.equal(EXAM_DURATION_SECONDS, 7200);
    assert.equal(getRemainingExamSeconds(now, now), 7200);
    assert.equal(getRemainingExamSeconds(now, now + 1000), 7199);
    assert.equal(getRemainingExamSeconds(now, now + 7200000), 0);
    assert.equal(getRemainingExamSeconds(now, now + 7201000), 0);
    assert.equal(EXAM_DEADLINE, Date.parse('2026-10-09T21:00:00+03:00'));
    assert.equal(EXAM_DEADLINE_LABEL, '09.10.2026 21:00');
    assert.equal(isExamClosedAt(EXAM_DEADLINE - 1), false);
    assert.equal(isExamClosedAt(EXAM_DEADLINE), true);
    assert.equal(isExamClosedAt(EXAM_DEADLINE + 1), true);

    const email = `test-${Date.now()}@example.com`;
    const startResponse = await fetch(`${baseUrl}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Test Katılımcı', email }),
      redirect: 'manual',
    });
    assert.equal(startResponse.status, 302);
    assert.equal(startResponse.headers.get('location'), '/instructions');
    const participantCookie = sessionCookie(startResponse);

    const instructions = await fetch(`${baseUrl}/instructions`, { headers: { Cookie: participantCookie } });
    assert.equal(instructions.status, 200);
    const instructionsHtml = await instructions.text();
    assert.match(instructionsHtml, /Sınav süresi:<\/b> 120 dakika/);
    assert.match(instructionsHtml, /Her soru 1 puan değerindedir/);
    assert.match(instructionsHtml, /Tarayıcıyı kapatmanız veya oturumunuzun kesilmesi/);
    assert.ok(instructionsHtml.includes('<button type="submit">Teste başla</button>'));

    const beginExam = await fetch(`${baseUrl}/exam/start`, {
      method: 'POST',
      headers: { Cookie: participantCookie },
      redirect: 'manual',
    });
    assert.equal(beginExam.status, 302);
    assert.equal(beginExam.headers.get('location'), '/exam');

    const exam = await fetch(`${baseUrl}/exam`, { headers: { Cookie: participantCookie } });
    assert.equal(exam.status, 200);
    const examHtml = await exam.text();
    assert.match(examHtml, /Test Katılımcı/);
    assert.match(examHtml, /<b>jspsplus<\/b>/);
    assert.match(examHtml, /data-remaining-seconds="7200"/);
    assert.match(examHtml, />120:00<\/span>/);

    const correctAnswer = (await db.get('SELECT answer FROM questions WHERE id=1')).answer;
    const submission = await fetch(`${baseUrl}/submit`, {
      method: 'POST',
      headers: { Cookie: participantCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'answers[q1]': correctAnswer }),
      redirect: 'manual',
    });
    assert.equal(submission.status, 302);
    const resultRow = await db.get('SELECT id,score,duration FROM results WHERE email=?', [email]);
    assert.equal(resultRow.score, 1, `Question answer was ${correctAnswer}`);
    assert.ok(resultRow.duration <= EXAM_DURATION_SECONDS);

    const result = await fetch(`${baseUrl}/result`, { headers: { Cookie: participantCookie } });
    assert.equal(result.status, 200);
    const resultHtml = await result.text();
    assert.match(resultHtml, /Sınav Tamamlandı/);
    assert.ok(resultHtml.includes('href="/">Giriş ekranına dön</a>'));
    assert.doesNotMatch(resultHtml, /href="\/leaderboard"/);
    const pdf = await fetch(`${baseUrl}/result/pdf`, { headers: { Cookie: participantCookie } });
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    const pdfData = new Uint8Array(await pdf.arrayBuffer());
    assert.ok(Buffer.from(pdfData).subarray(0, 5).equals(Buffer.from('%PDF-')));
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfLoadingTask = pdfjs.getDocument({ data: pdfData, useSystemFonts: false });
    const pdfDocument = await pdfLoadingTask.promise;
    let pdfText = '';
    let firstQuestionX;
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      const page = await pdfDocument.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageItems = textContent.items;
      const pageText = pageItems.map((item) => item.str).join(' ');
      pdfText += pageText;
      assert.equal(pageItems.filter((item) => item.str === 'JSPSPLUS').length, 3);
      const firstQuestion = pageItems.find((item) => item.str.startsWith('1. Örnek Soru 1'));
      if (firstQuestion) firstQuestionX = firstQuestion.transform[4];
    }
    await pdfLoadingTask.destroy();
    assert.ok(pdfText.includes('CEVAP ANAHTARI'));
    assert.ok(pdfText.includes('Katılımcı: Test Katılımcı'));
    assert.ok(pdfText.includes('Sizin cevabınız:'));
    assert.ok(pdfText.includes('Doğru cevap:'));
    assert.ok(pdfText.includes('Örnek Soru 1'));
    assert.ok(pdfText.includes('JSPSPLUS'));
    assert.ok((pdfText.match(/JSPSPLUS/g) || []).length >= 3);
    assert.equal(firstQuestionX, 45);
    const answerKeyText = pdfText.slice(pdfText.indexOf('CEVAP ANAHTARI'));
    assert.match(answerKeyText, /1\.\s*B/);
    assert.match(answerKeyText, /100\.\s*A/);

    const wrongNameLogin = await fetch(`${baseUrl}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Başka Katılımcı', email }),
    });
    assert.match(await wrongNameLogin.text(), /Ad soyad ve e-posta adresinizi kontrol edin/);
    const returningLogin = await fetch(`${baseUrl}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Test Katılımcı', email }),
      redirect: 'manual',
    });
    assert.equal(returningLogin.status, 302);
    assert.equal(returningLogin.headers.get('location'), '/result');
    const returningCookie = sessionCookie(returningLogin);
    const returningResult = await fetch(`${baseUrl}/result`, { headers: { Cookie: returningCookie } });
    assert.equal(returningResult.status, 200);
    const returningResultHtml = await returningResult.text();
    assert.match(returningResultHtml, /Sınav Tamamlandı/);
    assert.match(returningResultHtml, /sıralamalar, sınav girişleri sona erdikten sonra Cuma günü saat 21\.00'de yayınlanacaktır/i);
    assert.doesNotMatch(returningResultHtml, /<small>Sıra<\/small>/);
    const returningLeaderboard = await fetch(`${baseUrl}/leaderboard`, {
      headers: { Cookie: returningCookie },
      redirect: 'manual',
    });
    assert.equal(returningLeaderboard.status, 302);
    assert.equal(returningLeaderboard.headers.get('location'), '/');
    const returningPdf = await fetch(`${baseUrl}/result/pdf`, { headers: { Cookie: returningCookie } });
    assert.equal(returningPdf.status, 200);
    assert.equal(returningPdf.headers.get('content-type'), 'application/pdf');
    const savedReview = JSON.parse((await db.get(
      'SELECT review_json FROM results WHERE email=?',
      [email],
    )).review_json);
    assert.equal(savedReview.length, 100);
    assert.equal(savedReview[0].selectedAnswer, correctAnswer);

    await db.transaction(async (tx) => {
      for (let index = 0; index < 999; index++) {
        const score = index < 500 ? 2 : 0;
        await tx.run(
          'INSERT INTO results(name,email,email_key,score,correct,wrong,blank,duration) VALUES(?,?,?,?,?,?,?,?)',
          [`Katılımcı ${index}`, `competitor-${index}@example.com`, `competitor-${index}@example.com`, score, score, 0, 100 - score, 60],
        );
      }
    });

    const leaderboard = await fetch(`${baseUrl}/leaderboard`, {
      headers: { Cookie: participantCookie },
      redirect: 'manual',
    });
    const leaderboardHtml = await leaderboard.text();
    assert.equal(leaderboard.status, 302);
    assert.equal(leaderboard.headers.get('location'), '/');
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM results')).count, 1000);
    assert.doesNotMatch(leaderboardHtml, new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const publicLeaderboard = await fetch(`${baseUrl}/leaderboard`, { redirect: 'manual' });
    assert.equal(publicLeaderboard.status, 302);
    assert.equal(publicLeaderboard.headers.get('location'), '/');

    const adminLogin = await fetch(`${baseUrl}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: process.env.ADMIN_PASSWORD }),
      redirect: 'manual',
    });
    assert.equal(adminLogin.status, 302);
    const adminCookie = sessionCookie(adminLogin);
    const adminPage = await fetch(`${baseUrl}/admin`, { headers: { Cookie: adminCookie } });
    assert.equal(adminPage.status, 200);
    const adminHtml = await adminPage.text();
    assert.match(adminHtml, /Sonuçlar/);
    assert.ok(adminHtml.includes(`/admin/result/${resultRow.id}/delete`));

    const unauthorizedDelete = await fetch(`${baseUrl}/admin/result/${resultRow.id}/delete`, {
      method: 'POST',
      redirect: 'manual',
    });
    assert.equal(unauthorizedDelete.status, 302);
    assert.equal(unauthorizedDelete.headers.get('location'), '/admin/login');

    const deleteResponse = await fetch(`${baseUrl}/admin/result/${resultRow.id}/delete`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
      redirect: 'manual',
    });
    assert.equal(deleteResponse.status, 302);
    assert.equal(await db.get('SELECT id FROM results WHERE id=?', [resultRow.id]), undefined);
    assert.equal((await db.get('SELECT id FROM results WHERE email=?', [email])), undefined);

    const retake = await fetch(`${baseUrl}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Test Katılımcı', email }),
      redirect: 'manual',
    });
    assert.equal(retake.status, 302);
    const retakeCookie = sessionCookie(retake);
    assert.equal(retake.headers.get('location'), '/instructions');
    const retakeExam = await fetch(`${baseUrl}/exam`, { headers: { Cookie: retakeCookie } });
    assert.equal(retakeExam.status, 200);
    const retakeLeaderboard = await fetch(`${baseUrl}/leaderboard`, { headers: { Cookie: retakeCookie } });
    assert.doesNotMatch(await retakeLeaderboard.text(), /Kendi sıralamanız/);

    const templateResponse = await fetch(`${baseUrl}/admin/questions-template`, {
      headers: { Cookie: adminCookie },
    });
    const template = new ExcelJS.Workbook();
    await template.xlsx.load(Buffer.from(await templateResponse.arrayBuffer()));
    assert.equal(template.worksheets[0].rowCount, 101);

    const uploadWorkbook = new ExcelJS.Workbook();
    const worksheet = uploadWorkbook.addWorksheet('Sorular');
    worksheet.addRow(['Soru', 'A', 'B', 'C', 'D', 'E', 'DogruCevap']);
    for (let index = 1; index <= 100; index++) {
      worksheet.addRow([`Test sorusu ${index}`, 'A', 'B', 'C', 'D', 'E', 'A']);
    }
    const form = new FormData();
    form.append('excel', new Blob([await uploadWorkbook.xlsx.writeBuffer()]), 'questions.xlsx');
    const uploadResponse = await fetch(`${baseUrl}/admin/import-questions`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
      body: form,
      redirect: 'manual',
    });
    assert.equal(uploadResponse.status, 302);
    assert.equal((await db.get('SELECT question FROM questions WHERE id=1')).question, 'Test sorusu 1');

    const exportResponse = await fetch(`${baseUrl}/admin/export-results`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(exportResponse.status, 200);

    const closedResultEmail = `closed-result-${Date.now()}@example.com`;
    await db.run(
      'INSERT INTO results(name,email,email_key,score,correct,wrong,blank,duration,review_json) VALUES(?,?,?,?,?,?,?,?,?)',
      ['Kapanış Öncesi Katılımcı', closedResultEmail, closedResultEmail, 75, 75, 10, 15, 3600, '[]'],
    );
    app.locals.examDeadline = Date.now() - 1;

    const closedHome = await fetch(baseUrl);
    const closedHomeHtml = await closedHome.text();
    assert.equal(closedHome.status, 200);
    assert.match(closedHomeHtml, /Sınav girişleri kapalı/);
    assert.match(closedHomeHtml, /09\.10\.2026 21:00/);
    assert.doesNotMatch(closedHomeHtml, /Türkiye saati/);
    assert.ok(closedHomeHtml.includes('href="/leaderboard">Sıralamayı görüntüle</a>'));

    const resultsBeforeBlockedStart = (await db.get('SELECT COUNT(*) AS count FROM results')).count;
    const blockedStart = await fetch(`${baseUrl}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Yeni Katılımcı', email: `new-${Date.now()}@example.com` }),
    });
    assert.equal(blockedStart.status, 200);
    assert.match(await blockedStart.text(), /Yeni sınav başlatılamaz/);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM results')).count, resultsBeforeBlockedStart);

    const closedLeaderboard = await fetch(`${baseUrl}/leaderboard`, { redirect: 'manual' });
    assert.equal(closedLeaderboard.status, 200);
    assert.match(await closedLeaderboard.text(), /Ka\*\*\* Ön\*\*\*/);

    const closedReturningLogin = await fetch(`${baseUrl}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Kapanış Öncesi Katılımcı', email: closedResultEmail }),
      redirect: 'manual',
    });
    assert.equal(closedReturningLogin.status, 302);
    assert.equal(closedReturningLogin.headers.get('location'), '/result');
    const closedReturningCookie = sessionCookie(closedReturningLogin);
    const oldResultPage = await fetch(`${baseUrl}/result`, { headers: { Cookie: closedReturningCookie } });
    const oldResultHtml = await oldResultPage.text();
    assert.match(oldResultHtml, /Bu sonuç oluşturulduğunda sorular ve verilen cevaplar kaydedilmedi/);
    assert.match(oldResultHtml, /<small>Sıra<\/small>/);
    assert.doesNotMatch(oldResultHtml, /sıralamalar, sınav girişleri sona erdikten/);
    assert.doesNotMatch(oldResultHtml, /href="\/result\/pdf"/);
    const oldPdf = await fetch(`${baseUrl}/result/pdf`, { headers: { Cookie: closedReturningCookie } });
    assert.equal(oldPdf.status, 410);
    assert.match(await oldPdf.text(), /sorular ve verilen cevaplar kaydedilmediğinden PDF cevap dökümü oluşturulamıyor/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await db.close();
    fs.rmSync(testDirectory, { recursive: true, force: true });
  }
});
