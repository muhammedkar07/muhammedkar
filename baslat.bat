@echo off
chcp 65001 >nul
REM Aşağıdaki iki değeri MUTLAKA kendinize göre değiştirin
set ADMIN_PASSWORD=BURAYA-GUCLU-BIR-SIFRE-YAZIN
set SESSION_SECRET=BURAYA-UZUN-RASTGELE-BIR-METIN-YAZIN
npm start
