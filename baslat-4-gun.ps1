$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectDirectory

$envFile = Join-Path $projectDirectory '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
  throw 'Önce hazirla-4-gun.bat dosyasını çalıştırıp güvenli .env dosyasını oluşturun.'
}

$nodeCommand = Get-Command node -ErrorAction Stop
$tunnelCommand = Get-Command cloudflared -ErrorAction Stop
$settings = @{}
foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
  if ($line -match '^([^=]+)=(.*)$') {
    $settings[$matches[1]] = $matches[2]
  }
}
foreach ($key in @('ADMIN_PASSWORD', 'SESSION_SECRET')) {
  if (-not $settings.ContainsKey($key) -or $settings[$key] -match '^(replace-|BURAYA-)') {
    throw ".env içinde geçerli $key ayarlanmamış."
  }
}

$port = 3000
if ($settings.ContainsKey('PORT')) {
  $port = [int]$settings.PORT
}
$localUrl = "http://127.0.0.1:$port"
$logsDirectory = Join-Path $projectDirectory 'logs'
New-Item -ItemType Directory -Force -Path $logsDirectory | Out-Null
$nodeProcess = $null
$tunnelProcess = $null
$nodeOut = $null
$nodeErr = $null
$tunnelOut = $null
$tunnelErr = $null
$lastPublishedUrl = $null
$lastHealthWarning = $null

function Start-ExamServer {
  $script:nodeOut = Join-Path $logsDirectory ("server-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.out.log')
  $script:nodeErr = Join-Path $logsDirectory ("server-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.err.log')
  $script:nodeProcess = Start-Process -FilePath $nodeCommand.Source `
    -ArgumentList @('--env-file=.env', 'server.js') `
    -WorkingDirectory $projectDirectory `
    -RedirectStandardOutput $script:nodeOut `
    -RedirectStandardError $script:nodeErr `
    -WindowStyle Hidden -PassThru
  Write-Host "Sınav uygulaması başlatıldı (PID $($script:nodeProcess.Id))."
}

function Start-PublicTunnel {
  $script:tunnelOut = Join-Path $logsDirectory ("tunnel-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.out.log')
  $script:tunnelErr = Join-Path $logsDirectory ("tunnel-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.err.log')
  $script:tunnelProcess = Start-Process -FilePath $tunnelCommand.Source `
    -ArgumentList @('tunnel', '--url', $localUrl, '--no-autoupdate') `
    -WorkingDirectory $projectDirectory `
    -RedirectStandardOutput $script:tunnelOut `
    -RedirectStandardError $script:tunnelErr `
    -WindowStyle Hidden -PassThru
  Write-Host "Cloudflare tüneli başlatıldı (PID $($script:tunnelProcess.Id)). URL hazırlanıyor..."
}

function Get-PublicUrl {
  foreach ($file in @($tunnelOut, $tunnelErr)) {
    if ($file -and (Test-Path -LiteralPath $file)) {
      $match = Select-String -Path $file -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' |
        Select-Object -Last 1
      if ($match -and $match.Matches.Count -gt 0) {
        return $match.Matches[0].Value
      }
    }
  }
  return $null
}

Write-Host 'Sınav sunucusu çalışır durumda tutulacak. Bu pencereyi kapatmayın.'
Write-Host 'Durdurmak için Ctrl+C kullanın.'
Start-ExamServer
Start-PublicTunnel

try {
  while ($true) {
    if ($nodeProcess.HasExited) {
      Write-Warning 'Uygulama işlemi durdu; yeniden başlatılıyor. Sunucu hata kayıtları logs klasöründe.'
      Start-Sleep -Seconds 2
      Start-ExamServer
    }
    if ($tunnelProcess.HasExited) {
      Write-Warning 'Tünel bağlantısı kesildi; yeniden başlatılıyor. Yeni URL oluşursa katılımcılara tekrar gönderin.'
      Start-Sleep -Seconds 2
      Start-PublicTunnel
    }

    $publicUrl = Get-PublicUrl
    if ($publicUrl -and $publicUrl -ne $lastPublishedUrl) {
      $lastPublishedUrl = $publicUrl
      Write-Host ''
      Write-Host 'KATILIMCILARA GÖNDERECEĞİNİZ SINAV ADRESİ:' -ForegroundColor Green
      Write-Host $publicUrl -ForegroundColor Green
      Write-Host ''
    }

    try {
      $health = Invoke-WebRequest -Uri "$localUrl/healthz" -UseBasicParsing -TimeoutSec 4
      if ($health.StatusCode -ne 200) {
        throw "Health check returned HTTP $($health.StatusCode)."
      }
      $lastHealthWarning = $null
    }
    catch {
      $warning = "Yerel sağlık kontrolü başarısız: $($_.Exception.Message)"
      if ($warning -ne $lastHealthWarning) {
        Write-Warning $warning
        $lastHealthWarning = $warning
      }
    }

    Start-Sleep -Seconds 10
  }
}
finally {
  foreach ($process in @($tunnelProcess, $nodeProcess)) {
    if ($process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    }
  }
  Write-Host 'Sınav sunucusu ve tünel durduruldu.'
}
