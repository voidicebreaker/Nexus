# Starts a user-local runtime. No admin rights, router changes, or npm packages.
param([switch]$RotateKey, [switch]$PermanentTunnel)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Download-Checked([string]$Url, [string]$Destination, [string]$Hash) {
    if ($Hash -notmatch '^[a-fA-F0-9]{64}$') { throw 'The vendor did not supply a valid SHA256 checksum.' }
    if ((Test-Path $Destination) -and ((Get-FileHash $Destination -Algorithm SHA256).Hash -eq $Hash)) { return }
    $part = "$Destination.part"
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $part -TimeoutSec 300
    if ((Get-FileHash $part -Algorithm SHA256).Hash -ne $Hash) {
        Remove-Item $part -Force
        throw 'Download checksum did not match. Nothing was installed. Try again.'
    }
    Move-Item $part $Destination -Force
}

try {
    Write-Host ''
    Write-Host 'MindOverMatter / LM Studio sharing' -ForegroundColor Cyan
    Write-Host 'First launch downloads Node.js and Cloudflare Tunnel from their official releases.'
    Write-Host 'Downloads are checked against the vendors SHA256 checksums.'
    Write-Host ''
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'This launcher requires 64-bit Windows.' }
    $appDir = Join-Path $env:LOCALAPPDATA 'MindOverMatterLLM'
    New-Item -ItemType Directory -Path $appDir -Force | Out-Null

    Write-Host 'Checking the Node.js LTS runtime...'
    $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
    $release = $releases | Where-Object { $_.lts -and $_.files -contains 'win-x64-zip' -and [int]($_.version.Split('.')[0].TrimStart('v')) -ge 22 } | Select-Object -First 1
    if (-not $release -or $release.version -notmatch '^v\d+\.\d+\.\d+$') { throw 'Could not identify a supported Node.js LTS release.' }
    $version = $release.version
    $archiveName = "node-$version-win-x64.zip"
    $baseUrl = "https://nodejs.org/dist/$version"
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt" -TimeoutSec 30).Content
    $checksumLine = ($checksums -split "`n" | Where-Object { $_.Trim().EndsWith("  $archiveName") } | Select-Object -First 1)
    if (-not $checksumLine) { throw 'Node.js download checksum was not found.' }
    $archive = Join-Path $appDir $archiveName
    Download-Checked "$baseUrl/$archiveName" $archive ($checksumLine.Trim().Split(' ')[0])
    $nodeDir = Join-Path $appDir "node-$version-win-x64"
    $nodeExe = Join-Path $nodeDir 'node.exe'
    if (-not (Test-Path $nodeExe)) { Expand-Archive -LiteralPath $archive -DestinationPath $appDir -Force }

    Write-Host 'Checking Cloudflare Tunnel...'
    $cfRelease = Invoke-RestMethod -Uri 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest' -Headers @{ 'User-Agent' = 'MindOverMatter-LM-Share' } -TimeoutSec 30
    $asset = $cfRelease.assets | Where-Object { $_.name -eq 'cloudflared-windows-amd64.exe' } | Select-Object -First 1
    if (-not $asset -or $asset.browser_download_url -notlike 'https://github.com/cloudflare/cloudflared/releases/download/*') {
        throw 'Could not identify the official Cloudflare Tunnel download.'
    }
    $cfHash = ''
    if ($asset.digest -match '^sha256:([a-fA-F0-9]{64})$') { $cfHash = $Matches[1] }
    elseif ($cfRelease.body -match 'cloudflared-windows-amd64\.exe:\s*([a-fA-F0-9]{64})') { $cfHash = $Matches[1] }
    $cfExe = Join-Path $appDir 'cloudflared.exe'
    Download-Checked $asset.browser_download_url $cfExe $cfHash

    $env:MOM_STATE_DIR = $appDir
    $env:MOM_CLOUDFLARED = $cfExe
    if (-not $env:MOM_LM_URL) { $env:MOM_LM_URL = 'http://127.0.0.1:1234' }
    $lmUri = [Uri]$env:MOM_LM_URL
    if ($lmUri.Scheme -ne 'http' -or $lmUri.DnsSafeHost -notin @('localhost', '127.0.0.1', '::1') -or
        $lmUri.AbsolutePath -ne '/' -or $lmUri.UserInfo -or $lmUri.Query -or $lmUri.Fragment) {
        throw 'LM Studio must use a local HTTP address such as http://127.0.0.1:1234.'
    }
    $env:MOM_LM_URL = $lmUri.GetLeftPart([UriPartial]::Authority)
    Write-Host ''
    Write-Host "Checking LM Studio at $($env:MOM_LM_URL)..."
    $headers = @{}
    if ($env:MOM_LM_TOKEN) { $headers.Authorization = "Bearer $($env:MOM_LM_TOKEN)" }
    try {
        $models = Invoke-RestMethod -Uri "$($env:MOM_LM_URL)/v1/models" -Headers $headers -TimeoutSec 12
    } catch {
        $status = 0
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        if ($status -eq 401 -or $status -eq 403) {
            Write-Host 'LM Studio requires its API token. Paste it here (typing is hidden).'
            $secureToken = Read-Host 'LM Studio API token' -AsSecureString
            $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
            try { $env:MOM_LM_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
            finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
            $headers.Authorization = "Bearer $($env:MOM_LM_TOKEN)"
            $models = Invoke-RestMethod -Uri "$($env:MOM_LM_URL)/v1/models" -Headers $headers -TimeoutSec 12
        } else {
            throw 'LM Studio is not responding. Open LM Studio, load a chat model, open Developer, and start the server on port 1234. Then run this launcher again.'
        }
    }
    if (-not $models.data -or $models.data.Count -eq 0) { throw 'No models are available. Load a chat model in LM Studio, then run this launcher again.' }
    Write-Host 'LM Studio is ready.' -ForegroundColor Green
    Write-Host 'Available model identifiers (use one in your apps):'
    foreach ($model in $models.data) { Write-Host "  $($model.id)" }
    if ($PermanentTunnel) {
        Write-Host ''
        Write-Host 'Configure a named Cloudflare Tunnel first; see the Permanent address section in setup.html.'
        Write-Host 'Its published hostname must point to http://127.0.0.1:8787 on this PC.'
        $address = Read-Host 'Public address [https://llm.mindovermatter.space]'
        if (-not $address) { $address = 'https://llm.mindovermatter.space' }
        $publicUri = [Uri]$address
        if ($publicUri.Scheme -ne 'https' -or $publicUri.DnsSafeHost -notin @('llm.mindovermatter.space', 'ai.mindovermatter.space') -or
            -not $publicUri.IsDefaultPort -or $publicUri.AbsolutePath -ne '/' -or $publicUri.Query -or $publicUri.Fragment -or $publicUri.UserInfo) {
            throw 'Use https://llm.mindovermatter.space or https://ai.mindovermatter.space.'
        }
        $env:MOM_PUBLIC_URL = $publicUri.GetLeftPart([UriPartial]::Authority)
        Write-Host 'Paste only the Cloudflare tunnel token, not the full install command. Typing is hidden.'
        $secureTunnel = Read-Host 'Cloudflare tunnel token' -AsSecureString
        $tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureTunnel)
        try { $env:MOM_TUNNEL_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr).Trim() }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr) }
        if ($env:MOM_TUNNEL_TOKEN -notmatch '^[a-zA-Z0-9+/_.=-]{20,8000}$') { throw 'That is not a tunnel token. Paste only the token from the Cloudflare connector command.' }
    } else {
        Remove-Item Env:\MOM_TUNNEL_TOKEN -ErrorAction SilentlyContinue
        Remove-Item Env:\MOM_PUBLIC_URL -ErrorAction SilentlyContinue
    }
    $relayFile = Join-Path $PSScriptRoot 'relay.mjs'
    if (-not (Test-Path $relayFile)) { throw 'relay.mjs is missing. Extract the whole ZIP, then run Start-LM-Share.cmd from the extracted folder.' }
    $relayArgs = @($relayFile)
    if ($RotateKey) { $relayArgs += '--rotate-key' }
    & $nodeExe @relayArgs
    if ($LASTEXITCODE -ne 0) { throw "Sharing stopped (exit $LASTEXITCODE). If port 8787 is busy, close the other sharing window first." }
} catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ''
    exit 1
} finally {
    Remove-Item Env:\MOM_LM_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\MOM_TUNNEL_TOKEN -ErrorAction SilentlyContinue
}
