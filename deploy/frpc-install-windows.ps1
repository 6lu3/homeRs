# Windows 上安装 frpc 客户端
# 请以管理员身份运行 PowerShell

# 1. 下载 frpc（使用国内镜像）
$version = "0.61.1"
$url = "https://mirror.ghproxy.com/https://github.com/fatedier/frp/releases/download/v$version/frp_${version}_windows_amd64.zip"
$dest = "$env:TEMP\frp.zip"

Write-Host "下载 frpc v$version ..." -ForegroundColor Green
Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing

# 2. 解压到 C:\frp
Expand-Archive -Path $dest -DestinationPath "$env:TEMP\frp_tmp" -Force
$frpDir = Get-ChildItem "$env:TEMP\frp_tmp" | Select-Object -First 1
New-Item -ItemType Directory -Path "C:\frp" -Force | Out-Null
Copy-Item "$($frpDir.FullName)\frpc.exe" "C:\frp\" -Force

# 3. 创建配置文件（需要手动填写服务器信息）
$config = @"
serverAddr = "你的阿里云公网IP"
serverPort = 7000
auth.method = "token"
auth.token = "从云端获取的token"

log.to = "C:\\frp\\logs\\frpc.log"
log.level = "info"
log.maxDays = 7

transport.poolCount = 3

[[proxies]]
name = "home-inventory"
type = "tcp"
localIP = "127.0.0.1"
localPort = 3000
remotePort = 8080
"@

New-Item -ItemType Directory -Path "C:\frp\logs" -Force | Out-Null
$config | Out-File "C:\frp\frpc.toml" -Encoding UTF8
Write-Host "✓ 配置文件已创建: C:\frp\frpc.toml" -ForegroundColor Green
Write-Host "  请用记事本打开并填写服务器地址和 token" -ForegroundColor Yellow

# 4. 创建 Windows 服务（使用 NSSM）
$nssmUrl = "https://nssm.cc/release/nssm-2.24.zip"
$nssmZip = "$env:TEMP\nssm.zip"
Write-Host "下载 NSSM (服务管理工具)..." -ForegroundColor Green
Invoke-WebRequest -Uri $nssmUrl -OutFile $nssmZip -UseBasicParsing
Expand-Archive -Path $nssmZip -DestinationPath "$env:TEMP\nssm_tmp" -Force
$nssmExe = Get-ChildItem "$env:TEMP\nssm_tmp\nssm-*\win64\nssm.exe" | Select-Object -First 1
Copy-Item $nssmExe.FullName "C:\frp\" -Force

Write-Host "`n接下来手动操作:" -ForegroundColor Cyan
Write-Host "1. 编辑 C:\frp\frpc.toml，填入服务器 IP 和 token"
Write-Host "2. 以管理员身份运行:"
Write-Host "   cd C:\frp"
Write-Host "   .\nssm.exe install frpc C:\frp\frpc.exe -c C:\frp\frpc.toml"
Write-Host "   .\nssm.exe set frpc AppStdout C:\frp\logs\stdout.log"
Write-Host "   .\nssm.exe set frpc AppStderr C:\frp\logs\stderr.log"
Write-Host "   .\nssm.exe start frpc"
Write-Host "3. 查看状态: .\nssm.exe status frpc"
