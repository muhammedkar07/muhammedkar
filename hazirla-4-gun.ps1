$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $projectDirectory '.env'

if (Test-Path -LiteralPath $envFile) {
  throw '.env dosyası zaten var; güvenlik için üzerine yazılmadı. Mevcut ayarlarınızı koruyun.'
}

function New-SecureToken([int]$byteCount) {
  $bytes = New-Object byte[] $byteCount
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  }
  finally {
    $generator.Dispose()
  }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$adminPassword = New-SecureToken 24
$sessionSecret = New-SecureToken 48
$settings = @(
  'NODE_ENV=production'
  'PORT=3001'
  "ADMIN_PASSWORD=$adminPassword"
  "SESSION_SECRET=$sessionSecret"
  'SQLITE_PATH=data/exam.db'
)
[System.IO.File]::WriteAllLines($envFile, $settings, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host 'Uygulama için güvenli .env dosyası oluşturuldu.'
Write-Host 'Yönetici paneli şifreniz (bu şifreyi saklayın):' -ForegroundColor Yellow
Write-Host $adminPassword -ForegroundColor White
Write-Host ''
Write-Host 'Parolayı güvenli bir yere kaydedin. Yeniden oluşturma mevcut oturumları geçersiz kılar.'
