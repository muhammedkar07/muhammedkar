# Sınav uygulamasını ücretsiz yayımlama

Uygulama internete açık olduğunda herkes sınava katılabilir. Ücretsiz hizmetlerde kaynak ve kullanım kotaları vardır; yoğun veya kritik sınavlar için ücretsiz planlar kesintisiz çalışma garantisi vermez.

## Sınav dönemi için: kendi bilgisayarınızdan yayın

Sınav dönemi boyunca bu Windows bilgisayarını ve internet bağlantısını açık tutabiliyorsanız, mevcut SQLite veritabanını değiştirmeden ücretsiz olarak kullanabilirsiniz. Yeni sınav katılımı **09.10.2026 21:00** itibarıyla otomatik kapanır; sonrasında sıralama giriş sayfasından herkese açık olur. Sınav bitmeden sıralama sayfası görüntülenemez. Daha önce tamamlanmış sınavın sahibi aynı ad/e-posta ile kendi sonuç ve PDF'sine erişebilir. `cloudflared` bu bilgisayara zaten kurulmuş olmalıdır. Bu yöntem router'da port açmayı gerektirmez:

1. `hazirla-4-gun.bat` dosyasını **bir kez** çalıştırın. Güçlü bir yönetici parolası üretir; parolayı güvenli bir yere kaydedin. `.env` adlı sır dosyası proje klasöründe oluşturulur ve Git'e eklenmez. Bu parola kaybolursa `.env` dosyasındaki `ADMIN_PASSWORD` değerini kullanabilirsiniz.
2. `baslat-4-gun.bat` dosyasını çalıştırın. Açık kalan penceredeki `https://....trycloudflare.com` adresini katılımcılarla paylaşın. `/admin/login` yönetici girişidir.
3. Uygulama penceresini kapatmayın. `Ctrl+C` hem uygulamayı hem tüneli durdurur. Uygulama/tünel çökerse gözetmen işlemleri yeniden başlatır; tünel yeniden başlatılırsa yeni bir adres çıkar, bu adresi katılımcılara tekrar göndermeniz gerekir.
4. Bilgisayarı prize takın ve Windows'un uykuya geçmesini sınav boyunca kapatın. İnternet kesintisi veya bilgisayarın yeniden başlaması siteyi geçici olarak erişilmez yapar. Yeniden açarken `baslat-4-gun.bat` dosyasını tekrar çalıştırın.

**Süreklilik ve bağlantı uyarısı:** `trycloudflare.com` hızlı tüneli geçicidir; her başlatmada adres değişebilir, Cloudflare erişimi durdurabilir ve SLA/çalışma süresi garantisi yoktur. Bilgisayar kapanırsa site de kapanır. Bu nedenle bu, kısa bir etkinlik için ücretsiz ve pratik seçenektir; garantili/yüksek trafikli üretim hizmeti değildir. Sınavı başlatmadan önce bağlantıyı farklı bir cihazdan deneyin ve adresi katılımcılara gönderin. Herkese açık URL'yi alan herkes sayfalara erişebilir; yönetici parolasını veya `.env` dosyasını paylaşmayın.

Quick Tunnel (`trycloudflare.com`) adresi **özel bir ada çevrilemez**; adres Cloudflare tarafından rastgele verilir ve yeniden başlatmada değişebilir. Özel/kalıcı `jspsdenemesinavi...` adresi için kuruma ait DNS adı veya satın alınmış bir alan adı gerekir. Cloudflare'ın kendi açıklaması: [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

### Katılımcılara gönderilecek açıklama

> JSPS deneme sınavı ücretsizdir. Sınav bağlantısı, dört günlük etkinlik için geçici güvenli HTTPS yayını kullanır; bu nedenle adres `trycloudflare.com` ile biter. Lütfen yalnızca organizatörün bu mesajdaki bağlantısını kullanın: **[SINAV LİNKİ]**. Girişte adınız ve e-postanız istenir; e-posta adresiniz herkese açık sıralamada gösterilmez. Aynı e-posta adresiyle ikinci bir tamamlanmış sınava izin verilmez. Sınavı bitirince sonucunuzu ve soru-cevap PDF'nizi alabilirsiniz. Bu sınav için ücret veya parola talep edilmez.

Mesajı yalnızca güncel sınav adresi hazır olduktan sonra gönderin. Tünel yeniden başlatılırsa eski bağlantıyı kullanmayın; yeni adresi bu açıklamayla tekrar paylaşın.

Yayından önce yönetici panelini açıp sınav sorularını ve ayarlarını kontrol edin. Veriler bilgisayarınızdaki `data/exam.db` dosyasında kalır; veritabanı dosyasını kapatmadan kopyalamak yerine düzenli yedek alın. Üretim için hazırlanmış bu süreç `NODE_ENV=production` ve HTTPS güvenli oturum çerezlerini kullanır.

## Önerilen ücretsiz kurulum

- Uygulama sunucusu: [Render Free Web Service](https://render.com/docs/free#web-services)
- Kalıcı veritabanı: [Neon Free PostgreSQL](https://neon.com/docs/introduction/plans)
- Kaynak kodu: GitHub deposu (Render dağıtımı depoya bağlanır)

Render ücretsiz web hizmetleri 15 dakika istek almazsa uykuya geçer; sonraki ziyaretin açılması yaklaşık bir dakika sürebilir. Yerel dosyalar yeniden başlatma ve dağıtımlarda silinebildiği için SQLite dosyasını çevrimiçi sunucuda kullanmayın. Neon Free PostgreSQL veritabanı kalıcıdır; plan şu anda proje başına 1 GB depolama, 100 CU-saat işlem, 5 GB dış ağ aktarımı içerir ve kullanılmayınca beş dakika sonra sıfıra iner. Kotalar veya sağlayıcı kuralları değişebilir; kayıt olmadan önce resmi plan sayfalarını kontrol edin. Ücretsiz hizmetler yüksek katılımlı/resmî sınavlar için SLA veya yedekleme garantisi değildir.

## Kurulum ve yayınlama

1. Projeyi bir GitHub deposuna yükleyin. `data/exam.db`, `.env` ve gerçek şifreleri depoya eklemeyin.
2. Neon'da ücretsiz bir PostgreSQL projesi oluşturun. Neon bağlantı dizesini gizli tutun.
3. D: klasöründeki yerel `data/exam.db` dosyasındaki soru ve sonuçları bulut veritabanına **isteğe bağlı** olarak taşımak için, proje klasöründeki PowerShell penceresinde `DATABASE_URL` ve `.env` değişkenlerini ayarlayıp `npm run migrate:postgres` çalıştırın. Bu komut hedefte tabloları oluşturur, hedef tabloların boş olduğunu doğrular ve kaynak SQLite'ı salt okunur açar. Daha önce sonuç içeren veritabanlarını birleştirmez veya üzerine yazmaz. Katılımcı adları ve e-postaları da aktarılır; bunları taşımak istemiyorsanız bu adımı atlayın.
4. Render'da **New → Blueprint** ile GitHub deposunu bağlayıp `render.yaml` yapılandırmasını kullanın. Uygulama için `ADMIN_PASSWORD` belirleyin, `DATABASE_URL` alanına Neon bağlantı dizesini girin ve `SESSION_SECRET` için en az 32 rastgele karakterlik ayrı bir değer üretin.
5. Dağıtım tamamlanınca Render'ın verdiği `https://...onrender.com` adresini katılımcılarla paylaşın. `/admin/login` yönetici adresidir; parolayı katılımcılarla paylaşmayın.

Alternatif olarak Render'da **New → Web Service** seçip Build Command olarak `npm ci`, Start Command olarak `npm start` girin ve `render.yaml` içindeki ortam değişkenlerini elle ekleyin. `DATABASE_URL` ve sırlar GitHub'a veya herkese açık bir dosyaya konulmamalıdır.

## Yerel kullanım

Yerelde uygulama SQLite ile çalışmaya devam eder:

1. Node.js 22.13 veya üzerini kurun.
2. `npm install` çalıştırın.
3. `baslat.bat` dosyasındaki yönetici parolası ve oturum anahtarını değiştirip çalıştırın.
4. `http://localhost:3000` adresini açın.

Veriler `data/exam.db` dosyasına yazılır. Bulut PostgreSQL kullanmak için `DATABASE_URL` ortam değişkenini ayarlayın. `SQLITE_PATH` yalnızca yerel SQLite dosyasının konumunu değiştirir.

## Yayın öncesi ve kişisel veriler

- Ücretsiz yayın herkese açıktır; uygulamada hesap/e-posta doğrulaması yoktur. Bir e-postayla ikinci sınavı engelleme, e-posta adresinin sahibini doğrulamaz.
- Sınavı tamamlamış katılımcılar, giriş sayfasında aynı ad ve e-posta adresiyle devam ederek mevcut sonuçlarını tekrar açabilir; ikinci deneme başlatılmaz. Sıralama sınav bitiş saati olan 09.10.2026 21:00'e kadar gizlidir; bu saatten sonra giriş sayfasındaki bağlantıdan herkes görebilir.
- Sıralama herkese katılımcı adlarının maskelenmiş biçimini ve puanları gösterir; e-posta adresleri listelenmez. Yönetici panelinde ayrıntılı sonuçlar ve e-postalar görünür.
- Sonuç PDF'si sınav anındaki soru/seçenekleri, katılımcının seçimini ve doğru cevabı içerir. Yönetici soruları sonradan değiştirirse PDF yine katılımcının cevapladığı özgün soruları gösterir.
- Yönetici ekranından sonuç dışa aktarımı ve silme işlemleri yapılabilir. Sınav sonuçlarının sorumluluğu ve yedekleme size aittir.
- `ADMIN_PASSWORD` ve `SESSION_SECRET` için güçlü, birbirinden farklı değerler kullanın. Gerçek sırları `.env` dosyasına veya kaynak kontrolüne eklemeyin.
- Oturumlar PostgreSQL'de saklanır; uygulama HTTPS arkasında güvenli çerez kullanır.
- `.env.example` dosyası yalnızca değiştirilecek örnek değerleri içerir; kullanmadan önce yeni gizli değerler oluşturun.
