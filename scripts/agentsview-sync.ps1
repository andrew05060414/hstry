[CmdletBinding()]
param(
    [ValidateSet('all', 'chatgpt', 'claude', 'gemini', 'grok')]
    [string[]]$Provider = @('all'),

    [string]$ChronicleCommand = 'chronicle',
    [string]$ChronicleConfig,
    [string]$AgentsViewUrl = 'http://127.0.0.1:8080',
    [string]$AgentsViewDataDir,
    [string]$PythonCommand = 'python',
    [string]$StatePath,
    [string]$SessionRoot,
    [string]$BackupRoot,
    [int]$BatchSize = 100,
    [int]$RequestTimeoutSec = 1800,
    [int]$IntervalSeconds = 900,
    [switch]$Full,
    [switch]$DryRun,
    [switch]$Backup,
    [switch]$Watch
)

$ErrorActionPreference = 'Stop'

# How each web provider reaches AgentsView:
# - import: AgentsView's own chat importer (served by the running daemon).
# - native: files in the agent's native layout under $SessionRoot/<agent>, which
#   must be listed in AgentsView's [agents.<agent>] dirs, then parsed through
#   the daemon's session sync endpoint.
$providerDefinitions = [ordered]@{
    chatgpt = [ordered]@{
        adapters = @('chatgpt-web', 'chatgpt')
        format = 'chatgpt'
        mode = 'import'
        endpoint = '/api/v1/import/chatgpt'
        zip = $true
    }
    claude = [ordered]@{
        adapters = @('claude-web')
        format = 'claude-web'
        mode = 'import'
        endpoint = '/api/v1/import/claude-ai'
        zip = $false
    }
    gemini = [ordered]@{
        adapters = @('gemini')
        format = 'gemini-cli'
        mode = 'native'
        agent = 'gemini'
        syncFilter = '*.jsonl'
    }
    grok = [ordered]@{
        # The Grok CLI and the grok.com extension share the `grok` adapter;
        # only the extension's `grok-web` sources are web conversations.
        sourceIds = @('grok-web')
        format = 'grok'
        mode = 'native'
        agent = 'grok'
        syncFilter = 'summary.json'
    }
}

$chronicleHome = Join-Path $env:APPDATA 'hstry'
if (-not $StatePath) { $StatePath = Join-Path $chronicleHome 'agentsview-sync.json' }
if (-not $SessionRoot) { $SessionRoot = Join-Path $chronicleHome 'agentsview-web' }
if (-not $BackupRoot) { $BackupRoot = Join-Path $chronicleHome 'agentsview-backups' }
if (-not $AgentsViewDataDir) {
    $AgentsViewDataDir = if ($env:AGENTSVIEW_DATA_DIR) { $env:AGENTSVIEW_DATA_DIR } else { Join-Path $HOME '.agentsview' }
}
$AgentsViewUrl = $AgentsViewUrl.TrimEnd('/')

function Invoke-Chronicle {
    param([string[]]$Arguments)

    $prefix = if ($ChronicleConfig) { @('--config', $ChronicleConfig) } else { @() }
    $output = & $ChronicleCommand @prefix @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Chronicle command failed with exit ${LASTEXITCODE}: $($Arguments[0..1] -join ' ')"
    }
    return ($output -join [Environment]::NewLine)
}

function Get-ProviderRows {
    param($Definition)

    $sources = @((Invoke-Chronicle @('--json', 'source', 'list') | ConvertFrom-Json).result | Where-Object {
        $id = [string]$_.id
        if ($Definition.sourceIds) {
            foreach ($prefix in $Definition.sourceIds) {
                if ($id -eq $prefix -or $id -like "$prefix-*") { return $true }
            }
            return $false
        }
        return $Definition.adapters -contains [string]$_.adapter
    })
    $sourceIds = @($sources | ForEach-Object { [string]$_.id })

    # `list --source` also matches related sources, so keep only exact source
    # ids and de-duplicate conversation ids.
    $rows = @{}
    foreach ($sourceId in $sourceIds) {
        $payload = Invoke-Chronicle @('--json', 'list', '--source', $sourceId, '--limit', '1000000') | ConvertFrom-Json
        foreach ($row in @($payload.result)) {
            if ($sourceIds -contains [string]$row.source_id) { $rows[[string]$row.id] = $row }
        }
    }
    return [pscustomobject]@{ sources = $sourceIds; rows = @($rows.Values) }
}

function Get-UpdatedAt { param($Row)
    # ConvertFrom-Json turns ISO timestamps into DateTime; normalize to UTC ISO.
    $value = if ($Row.updated_at) { $Row.updated_at } else { $Row.created_at }
    if ($value -is [datetime]) { return $value.ToUniversalTime().ToString('o') }
    return [string]$value
}

function Select-UniqueConversations {
    param([object[]]$Rows)

    # The same web conversation can be captured by several sources (official
    # export plus browser extension). Keep the most complete copy.
    return @($Rows | Group-Object { if ($_.external_id) { [string]$_.external_id } else { [string]$_.id } } | ForEach-Object {
        $_.Group | Sort-Object -Property @(
            @{ Expression = { [int64]$_.message_count }; Descending = $true },
            @{ Expression = { Get-UpdatedAt $_ }; Descending = $true },
            @{ Expression = { [string]$_.source_id }; Descending = $false },
            @{ Expression = { [string]$_.id }; Descending = $false }
        ) | Select-Object -First 1
    })
}

function Get-StateKey { param([string]$ProviderName, $Row)
    $external = if ($Row.external_id) { [string]$Row.external_id } else { [string]$Row.id }
    return "${ProviderName}::$external"
}

function Get-Fingerprint { param($Row)
    # Content-based so an identical copy in another source does not look new.
    return "$([int64]$Row.message_count)@$(Get-UpdatedAt $Row)"
}

function Read-SyncState {
    $state = @{ backup = $null; conversations = @{} }
    if (-not (Test-Path -LiteralPath $StatePath)) { return $state }

    $raw = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    $state.backup = $raw.backup
    if ($raw.conversations) {
        foreach ($property in $raw.conversations.PSObject.Properties) {
            $state.conversations[$property.Name] = [string]$property.Value
        }
    }
    return $state
}

function Write-SyncState {
    param([hashtable]$State)

    $parent = Split-Path -Parent $StatePath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $temp = "$StatePath.tmp"
    $State | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $StatePath -Force
}

function Backup-AgentsViewDatabase {
    $database = Join-Path $AgentsViewDataDir 'sessions.db'
    if (-not (Test-Path -LiteralPath $database)) { throw "AgentsView database not found: $database" }

    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssZ')
    $targetDir = Join-Path $BackupRoot $stamp
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    $target = Join-Path $targetDir 'sessions.db'

    # SQLite's online backup API gives a consistent copy while the daemon keeps
    # writing; copying the db/-wal files separately would not.
    $script = 'import sqlite3, sys; s = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True); d = sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()'
    & $PythonCommand -c $script ($database -replace '\\', '/') $target
    if ($LASTEXITCODE -ne 0) { throw "AgentsView database backup failed with exit $LASTEXITCODE" }

    $manifest = [ordered]@{
        created_at = (Get-Date).ToUniversalTime().ToString('o')
        source = $database
        file = 'sessions.db'
        bytes = (Get-Item -LiteralPath $target).Length
        sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
    }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $targetDir 'manifest.json') -Encoding UTF8
    return $targetDir
}

function Get-AgentsViewHeaders {
    # The daemon rejects state-changing requests without a same-origin header.
    $headers = @{ Origin = $AgentsViewUrl }
    $config = Join-Path $AgentsViewDataDir 'config.toml'
    if (Test-Path -LiteralPath $config) {
        $line = Select-String -LiteralPath $config -Pattern '^\s*auth_token\s*=\s*"([^"]+)"' | Select-Object -First 1
        if ($line) { $headers.Authorization = "Bearer $($line.Matches[0].Groups[1].Value)" }
    }
    return $headers
}

function Assert-AgentsViewReady {
    param([string[]]$NativeAgents)

    try {
        $null = Invoke-RestMethod -Uri "$AgentsViewUrl/api/v1/sync/status" -Headers (Get-AgentsViewHeaders) -TimeoutSec 10
    } catch {
        throw "AgentsView daemon is not reachable at $AgentsViewUrl; start it with 'agentsview daemon start'"
    }

    $config = Join-Path $AgentsViewDataDir 'config.toml'
    $text = if (Test-Path -LiteralPath $config) { (Get-Content -LiteralPath $config -Raw) -replace '\\\\', '/' -replace '\\', '/' } else { '' }
    foreach ($agent in $NativeAgents) {
        $dir = (Join-Path $SessionRoot $agent) -replace '\\', '/'
        if ($text.IndexOf($dir, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            throw "AgentsView [agents.$agent] dirs must include '$dir' (keep the default directory in the list too), then restart the daemon"
        }
    }
}

function Invoke-AgentsViewForm {
    param([string]$Path, [string]$File)

    $request = @{
        Method = 'Post'
        Uri = "$AgentsViewUrl$Path"
        Headers = Get-AgentsViewHeaders
        Form = @{ file = Get-Item -LiteralPath $File }
        TimeoutSec = $RequestTimeoutSec
    }
    return Invoke-RestMethod @request
}

function Invoke-AgentsViewSessionSync {
    param([string]$File)

    $request = @{
        Method = 'Post'
        Uri = "$AgentsViewUrl/api/v1/sessions/sync"
        Headers = Get-AgentsViewHeaders
        ContentType = 'application/json'
        Body = @{ path = $File } | ConvertTo-Json
        TimeoutSec = $RequestTimeoutSec
    }
    return Invoke-RestMethod @request
}

function Export-Batch {
    param([string]$Format, [string[]]$Ids, [string]$OutputPath)

    $null = Invoke-Chronicle @('export', '--format', $Format, '--conversations', ($Ids -join ','), '--output', $OutputPath)
}

function Sync-Provider {
    param([string]$ProviderName, [hashtable]$State)

    $definition = $providerDefinitions[$ProviderName]
    $found = Get-ProviderRows $definition
    $unique = @(Select-UniqueConversations $found.rows)
    $changed = @($unique | Where-Object {
        $Full -or $State.conversations[(Get-StateKey $ProviderName $_)] -ne (Get-Fingerprint $_)
    })
    $summary = [ordered]@{
        provider = $ProviderName
        sources = $found.sources
        rows = $found.rows.Count
        unique = $unique.Count
        changed = $changed.Count
        imported = 0
        updated = 0
        skipped = 0
        errors = 0
    }
    if ($changed.Count -eq 0 -or $DryRun) { return [pscustomobject]$summary }

    if (-not $State.backup -or $Backup) {
        $State.backup = Backup-AgentsViewDatabase
        Write-SyncState $State
    }

    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("chronicle-agentsview-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $temp | Out-Null
    try {
        for ($offset = 0; $offset -lt $changed.Count; $offset += $BatchSize) {
            $batch = @($changed[$offset..([Math]::Min($offset + $BatchSize, $changed.Count) - 1)])
            $ids = @($batch | ForEach-Object { [string]$_.id })
            $batchDir = Join-Path $temp "batch-$offset"
            New-Item -ItemType Directory -Force -Path $batchDir | Out-Null

            if ($definition.mode -eq 'import') {
                $json = Join-Path $batchDir 'conversations.json'
                Export-Batch $definition.format $ids $json
                $upload = $json
                if ($definition.zip) {
                    $upload = Join-Path $batchDir 'export.zip'
                    Compress-Archive -LiteralPath $json -DestinationPath $upload -Force
                }
                $stats = Invoke-AgentsViewForm $definition.endpoint $upload
                foreach ($name in 'imported', 'updated', 'skipped', 'errors') { $summary[$name] += [int64]$stats.$name }
                $batchErrors = [int64]$stats.errors
            } else {
                $exportDir = Join-Path $batchDir 'export'
                Export-Batch $definition.format $ids $exportDir
                $agentRoot = Join-Path $SessionRoot $definition.agent
                $files = @(Get-ChildItem -LiteralPath $exportDir -Recurse -File)
                $synced = 0
                $batchErrors = 0
                foreach ($file in $files) {
                    $relative = [System.IO.Path]::GetRelativePath($exportDir, $file.FullName)
                    $target = Join-Path $agentRoot $relative
                    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
                    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
                    if ($file.Name -like $definition.syncFilter) {
                        $session = Invoke-AgentsViewSessionSync $target
                        $synced++
                        if ([int64]$session.message_count -gt 0) { $summary.imported++ } else { $batchErrors++ }
                    }
                }
                if ($synced -ne $batch.Count) {
                    throw "Chronicle exported $($batch.Count) $ProviderName conversations but AgentsView synced $synced session files"
                }
                $summary.errors += $batchErrors
            }

            # A batch with errors stays pending so the next run retries it;
            # AgentsView imports are idempotent.
            if ($batchErrors -gt 0) { continue }
            foreach ($row in $batch) {
                $State.conversations[(Get-StateKey $ProviderName $row)] = Get-Fingerprint $row
            }
            Write-SyncState $State
        }
    } finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }

    return [pscustomobject]$summary
}

function Invoke-SyncOnce {
    $state = Read-SyncState
    $names = if ($Provider -contains 'all') { @($providerDefinitions.Keys) } else { @($Provider | Select-Object -Unique) }
    if (-not $DryRun) {
        $nativeAgents = @($names | ForEach-Object { $providerDefinitions[$_] } | Where-Object { $_.mode -eq 'native' } | ForEach-Object { $_.agent })
        Assert-AgentsViewReady $nativeAgents
    }
    $results = foreach ($name in $names) { Sync-Provider $name $state }

    [pscustomobject]@{
        dry_run = [bool]$DryRun
        backup = $state.backup
        state = $StatePath
        session_root = $SessionRoot
        results = @($results)
    } | ConvertTo-Json -Depth 6
}

do {
    Invoke-SyncOnce
    if ($Watch) { Start-Sleep -Seconds ([Math]::Max(60, $IntervalSeconds)) }
} while ($Watch)
