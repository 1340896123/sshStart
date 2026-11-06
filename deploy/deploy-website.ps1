param(
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$SshHost = 'fwd',
    [switch]$SkipReleaseSync
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseId = [DateTime]::UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'") + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$outputRoot = Join-Path $projectRoot 'output/website-deploy'
$archive = Join-Path $outputRoot ($releaseId + '.tar.gz')
$remotePrefix = '/tmp/sshstar-website-' + $releaseId

function Assert-Command([string]$Step) {
    if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}

Push-Location $projectRoot
try {
    if (!(Test-Path 'website/node_modules/.bin/vite.cmd')) {
        npm --prefix website ci
        Assert-Command 'Website dependency installation'
    }
    if (!$SkipReleaseSync) {
        npm --prefix website run release:sync
        Assert-Command 'Release asset verification'
    }
    npm run build:website
    Assert-Command 'Website build'
    New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
    tar -czf $archive -C website/dist .
    Assert-Command 'Website packaging'
    scp -o BatchMode=yes $archive "${SshHost}:${remotePrefix}.tar.gz"
    Assert-Command 'Website upload'
    scp -o BatchMode=yes deploy/install-website.py "${SshHost}:${remotePrefix}.py"
    Assert-Command 'Installer upload'
    scp -o BatchMode=yes deploy/sshstar-website.Caddyfile "${SshHost}:${remotePrefix}.Caddyfile"
    Assert-Command 'Caddy snippet upload'
    ssh -o BatchMode=yes $SshHost "python3 '${remotePrefix}.py' '${remotePrefix}.tar.gz' '${remotePrefix}.Caddyfile' '$releaseId'"
    Assert-Command 'Remote website installation'
    Write-Output "Website release deployed: $releaseId"
    Write-Output 'Verify HTTPS and downloads at https://sshstar.123756.xyz/'
}
finally {
    Pop-Location
}
