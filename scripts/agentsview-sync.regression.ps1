$ErrorActionPreference = 'Stop'
$pwsh = (Get-Command pwsh.exe).Source
$repo = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("chronicle-av-sync-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null

try {
    $chronicle = Join-Path $testRoot 'chronicle-fixture.ps1'
    @'
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$CliArgs)
$ErrorActionPreference = 'Stop'
$fixture = $env:AV_FIXTURE
if ($CliArgs -contains 'source') {
    '{"result":[{"id":"chatgpt-web","adapter":"chatgpt-web"}]}'
    exit 0
}
if ($CliArgs -contains 'list') {
    '{"result":' + (Get-Content -LiteralPath (Join-Path $fixture 'rows.json') -Raw) + '}'
    exit 0
}
if ($CliArgs -contains 'export') {
    $outIndex = [Array]::IndexOf($CliArgs, '--output') + 1
    $idIndex = [Array]::IndexOf($CliArgs, '--conversations') + 1
    $ids = $CliArgs[$idIndex].Split(',')
    $rows = @(Get-Content -LiteralPath (Join-Path $fixture 'conversations.json') -Raw | ConvertFrom-Json | Where-Object { $ids -contains $_.id })
    $rows | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $CliArgs[$outIndex] -Encoding utf8
    exit 0
}
exit 2
'@ | Set-Content -LiteralPath $chronicle -Encoding utf8

    $largeMessages = @(
        for ($index = 0; $index -lt 1002; $index++) {
            @{ role=$(if ($index % 2 -eq 0) { 'user' } else { 'assistant' }); content="message-$index" }
        }
    )
    $conversations = @(
        @{ id='c-one'; externalId='one'; messages=$largeMessages },
        @{ id='c-two'; externalId='two'; messages=@(@{role='user';content='new prompt'},@{role='assistant';content='new answer'}) }
    )
    $conversations | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $testRoot 'conversations.json') -Encoding utf8
    @(
        @{ id='c-one'; source_id='chatgpt-web'; external_id='one'; message_count=1002; created_at='2026-09-01T00:00:00Z'; updated_at='2026-09-01T00:01:00Z' },
        @{ id='c-two'; source_id='chatgpt-web'; external_id='two'; message_count=2; created_at='2026-09-02T00:00:00Z'; updated_at='2026-09-02T00:01:00Z' }
    ) | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $testRoot 'rows.json') -Encoding utf8

    # HttpListener does not allocate port zero. Reserve a loopback port, then bind it.
    $probe = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $probe.Start(); $port = ([Net.IPEndPoint]$probe.LocalEndpoint).Port; $probe.Stop()

    function Invoke-FixtureRun([string]$Mode, [string]$StatePath) {
        $server = [System.Net.HttpListener]::new()
        $server.Prefixes.Add("http://127.0.0.1:$port/")
        $server.Start()
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $pwsh
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        foreach ($arg in @('-NoProfile','-File',(Join-Path $repo 'scripts/agentsview-sync.ps1'),'-Provider','chatgpt','-ChronicleCommand',$chronicle,'-AgentsViewUrl',"http://127.0.0.1:$port",'-AgentsViewDataDir',$testRoot,'-StatePath',$StatePath,'-BatchSize','10')) { $psi.ArgumentList.Add($arg) }
        $psi.Environment['AV_FIXTURE'] = $testRoot
        $psi.Environment['AV_SERVER_MODE'] = $Mode
        $process = [System.Diagnostics.Process]::Start($psi)
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        try {
          $accept = $server.GetContextAsync()
          while ($true) {
            if (-not $accept.Wait(1000)) { if ($process.HasExited) { break }; continue }
            $context = $accept.GetAwaiter().GetResult()
            $accept = $server.GetContextAsync()
            $path = $context.Request.Url.AbsolutePath
            $segments = @($path.Trim('/').Split('/'))
            $id = [uri]::UnescapeDataString($segments[-1])
            $body = '{}'
            if ($path -eq '/api/v1/sync/status') { $body = '{}' }
            elseif ($path -eq '/api/v1/import/chatgpt') {
                if ($Mode -eq 'patched') { $body = '{"imported":0,"updated":1,"skipped":1,"errors":0}' }
                else { $body = '{"imported":0,"updated":0,"skipped":2,"errors":0}' }
            }
            elseif ($path -match '/api/v1/sessions/.+/messages$') {
                $which = [uri]::UnescapeDataString(($path -split '/')[-2])
                $allMessages = if ($which -eq 'chatgpt:one') {
                    for ($index = 0; $index -lt $largeMessages.Count; $index++) {
                        @{ role=$largeMessages[$index].role; content=$largeMessages[$index].content; ordinal=($index * 2) }
                    }
                } else {
                    $answer = if ($Mode -eq 'patched') { 'new answer' } else { 'old answer' }
                    @(@{role='user';content='new prompt';ordinal=0},@{role='assistant';content=$answer;ordinal=1})
                }
                $from = [int]$context.Request.QueryString['from']
                $messages = @($allMessages | Where-Object { $_.ordinal -ge $from } | Select-Object -First 1000)
                $body = @{messages=$messages;count=$messages.Count;first_ordinal=$(if ($messages.Count) { $messages[0].ordinal });last_ordinal=$(if ($messages.Count) { $messages[-1].ordinal })} | ConvertTo-Json -Depth 5 -Compress
            }
            elseif ($path -match '/api/v1/sessions/.+$') {
                $count = if ($id -eq 'chatgpt:one') { 1002 } else { 2 }
                $body = @{ id=$id; message_count=$count; transcript_revision='rev-1' } | ConvertTo-Json -Compress
            }
            $bytes = [Text.Encoding]::UTF8.GetBytes($body)
            $context.Response.ContentType = 'application/json'
            $context.Response.ContentLength64 = $bytes.Length
            $context.Response.OutputStream.Write($bytes,0,$bytes.Length)
            $context.Response.Close()
          }
        } finally {
            $server.Stop()
            $server.Close()
        }
        $process.WaitForExit()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        $exit = $process.ExitCode
        if ($exit -ne 0) { throw "Bridge exited $($exit): $stderr" }
        return ($stdout | ConvertFrom-Json)
    }

    $state = Join-Path $testRoot 'state.json'
    @{ backup='fixture'; conversations=@{} } | ConvertTo-Json -Depth 4 | Set-Content $state -Encoding utf8
    $oldResult = Invoke-FixtureRun 'official' $state
    $stateData = Get-Content $state -Raw | ConvertFrom-Json
    if ($oldResult.results[0].skipped -ne 2 -or $oldResult.results[0].errors -ne 1) { throw "Mixed skipped/stale batch was not reported accurately: $($oldResult.results[0] | ConvertTo-Json -Compress)" }
    if (-not $stateData.conversations.'chatgpt::one' -or $stateData.conversations.'chatgpt::two') { throw 'Only content-verified conversation should be acknowledged' }

    # Simulate the historical false acknowledgement for the stale row and prove reconciliation removes it.
    $stateData.conversations | Add-Member -NotePropertyName 'chatgpt::two' -NotePropertyValue '2@2026-09-02T00:01:00.0000000Z' -Force
    $stateData | ConvertTo-Json -Depth 4 | Set-Content $state -Encoding utf8
    $reconciled = Invoke-FixtureRun 'official' $state
    $stateData = Get-Content $state -Raw | ConvertFrom-Json
    if ($reconciled.results[0].errors -ne 1 -or $stateData.conversations.'chatgpt::two') { throw 'False acknowledged fingerprint was not reconciled to pending' }

    $fixedState = Join-Path $testRoot 'fixed-state.json'
    @{ backup='fixture'; conversations=@{} } | ConvertTo-Json -Depth 4 | Set-Content $fixedState -Encoding utf8
    $fixed = Invoke-FixtureRun 'patched' $fixedState
    $fixedData = Get-Content $fixedState -Raw | ConvertFrom-Json
    if ($fixed.results[0].errors -ne 0 -or -not $fixedData.conversations.'chatgpt::two') { throw 'Append-only updated content was not verified and acknowledged' }
    'PASS mixed skipped/stale batch, false-state reconciliation, and patched append update'
} finally {
    $root = [System.IO.Path]::GetFullPath($testRoot)
    $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($root.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $root) -like 'chronicle-av-sync-test-*') {
        Remove-Item -LiteralPath $root -Recurse -Force
    }
}
