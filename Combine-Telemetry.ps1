<#
.SYNOPSIS
    Combines MyFlightbook telemetry files (.CSV and .KML) into a single Google Earth KML.

.DESCRIPTION
    Each input file becomes one timestamped gx:Track (so Google Earth's time slider works),
    grouped in a folder and sorted by start time. Tracks are colored per flight.

    CSV files are expected to have the MyFlightbook header:
        LAT,LON,PALT,SPEED,HERROR,DATE,TZOFFSET,COMMENT
    PALT is treated as feet MSL and converted to meters.

    KML files are expected to contain gx:Track elements (<when>/<gx:coord>) or LineStrings.
    Tracks whose altitudes are all 0 are clamped to the ground.

.EXAMPLE
    .\Combine-Telemetry.ps1
    .\Combine-Telemetry.ps1 -InputDir C:\telemetry -OutputFile C:\out\all-flights.kml
#>
param(
    [string]$InputDir = $PSScriptRoot,
    [string]$OutputFile = (Join-Path $PSScriptRoot 'combined-flights.kml'),
    # Tour: per flight, the camera first zooms out to fit it (TourZoomSeconds), then the track
    # is traced (TourTraceSeconds, in TourTraceSteps keyframes). TourTraceSeconds 0 = no tour.
    [double]$TourZoomSeconds = 0.75,
    [double]$TourTraceSeconds = 1,
    [int]$TourTraceSteps = 10,
    [double]$TourMinRangeMeters = 8000
)

$ErrorActionPreference = 'Stop'
$inv = [Globalization.CultureInfo]::InvariantCulture

# KML colors are aabbggrr
$palette = @('ff1c1ae3', 'ffff7f00', 'ff00c000', 'ff00a5ff', 'ffff00ff', 'ffffff00', 'ff0080ff', 'ff8000ff', 'ff00ffff', 'ff7f7fff')

# Files are sometimes briefly locked (antivirus/indexer/sync), so open with permissive sharing and retry
function Read-AllTextWithRetry([string]$path) {
    for ($i = 1; $i -le 8; $i++) {
        try {
            $fs = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
            try { return (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
        }
        catch { if ($i -eq 8) { throw }; Start-Sleep -Milliseconds (300 * $i) }
    }
}

function Get-CsvTrack([string]$text) {
    $whens = New-Object System.Collections.Generic.List[string]
    $coords = New-Object System.Collections.Generic.List[string]
    $lines = $text -split "`r?`n"
    $hdr = $lines[0].Split(',') | ForEach-Object { $_.Trim().ToUpperInvariant() }
    $iLat = [array]::IndexOf($hdr, 'LAT'); $iLon = [array]::IndexOf($hdr, 'LON')
    $iAlt = [array]::IndexOf($hdr, 'PALT'); $iDate = [array]::IndexOf($hdr, 'DATE')
    if ($iLat -lt 0 -or $iLon -lt 0) { throw 'CSV has no LAT/LON columns' }

    for ($n = 1; $n -lt $lines.Length; $n++) {
        $f = $lines[$n].Split(',')
        if ($f.Length -le [Math]::Max($iLat, $iLon)) { continue }
        $lat = 0.0; $lon = 0.0; $alt = 0.0
        if (-not [double]::TryParse($f[$iLat], [Globalization.NumberStyles]::Float, $inv, [ref]$lat)) { continue }
        if (-not [double]::TryParse($f[$iLon], [Globalization.NumberStyles]::Float, $inv, [ref]$lon)) { continue }
        if ($iAlt -ge 0 -and $f.Length -gt $iAlt) {
            [void][double]::TryParse($f[$iAlt], [Globalization.NumberStyles]::Float, $inv, [ref]$alt)
        }
        $when = if ($iDate -ge 0 -and $f.Length -gt $iDate) { $f[$iDate].Trim() } else { '' }
        $whens.Add($when)
        $coords.Add(('{0} {1} {2}' -f $lon.ToString('R', $inv), $lat.ToString('R', $inv), ($alt * 0.3048).ToString('0.#', $inv)))
    }
    return @{ Whens = $whens; Coords = $coords; Name = $null }
}

function Get-KmlTrack([string]$text) {
    $whens = New-Object System.Collections.Generic.List[string]
    $coords = New-Object System.Collections.Generic.List[string]
    foreach ($m in [regex]::Matches($text, '<when\s*>([^<]*)</when>')) { $whens.Add($m.Groups[1].Value.Trim()) }
    foreach ($m in [regex]::Matches($text, '<gx:coord\s*>([^<]*)</gx:coord>')) { $coords.Add($m.Groups[1].Value.Trim()) }

    if ($coords.Count -eq 0) {
        # Fallback: plain LineString coordinates ("lon,lat,alt lon,lat,alt ...")
        $whens.Clear()
        foreach ($m in [regex]::Matches($text, '<coordinates\s*>([^<]*)</coordinates>')) {
            foreach ($tuple in ($m.Groups[1].Value -split '\s+')) {
                if ($tuple) { $coords.Add(($tuple -replace ',', ' ')) }
            }
        }
    }
    $name = $null
    $pm = [regex]::Match($text, '<Placemark\s*>\s*<name\s*>([^<]*)</name>')
    if ($pm.Success) { $name = $pm.Groups[1].Value.Trim() }
    return @{ Whens = $whens; Coords = $coords; Name = $name }
}

function Escape-Xml([string]$s) { [Security.SecurityElement]::Escape($s) }

# Writes a gx:Tour that replays the flights in order. For each flight the camera first widens to
# frame everything drawn so far plus the whole new flight, then holds still while the flight is traced.
# The framed area only grows, so the view only ever zooms out.
function Write-Tour($w, $tracks) {
    $timed = @($tracks | Where-Object { $_.HasTime -and $_.Start })
    if (-not $timed.Count) { return }
    $tourBegin = $timed[0].Whens[0]
    $minLat = 90.0; $maxLat = -90.0; $minLon = 180.0; $maxLon = -180.0
    $halfFov = [Math]::PI / 6   # Google Earth's default 60 degree horizontal field of view

    $flyTo = {
        param([double]$dur, [string]$end)
        $w.WriteLine((('<gx:FlyTo><gx:duration>{0}</gx:duration><gx:flyToMode>smooth</gx:flyToMode><LookAt>' +
            '<gx:TimeSpan><begin>{1}</begin><end>{2}</end></gx:TimeSpan>' +
            '<longitude>{3}</longitude><latitude>{4}</latitude><altitude>0</altitude>' +
            '<heading>0</heading><tilt>0</tilt><range>{5}</range><altitudeMode>relativeToGround</altitudeMode>' +
            '</LookAt></gx:FlyTo>') -f $dur.ToString($inv), $tourBegin, $end,
            $cLon.ToString('R', $inv), $cLat.ToString('R', $inv), $range.ToString('0', $inv)))
    }

    $w.WriteLine('<gx:Tour><name>Flight history zoom-out</name><gx:Playlist>')
    foreach ($t in $timed) {
        foreach ($c in $t.Coords) {
            $p = $c.Split(' ')
            $lon = [double]::Parse($p[0], $inv); $lat = [double]::Parse($p[1], $inv)
            if ($lat -eq 0 -and $lon -eq 0) { continue }   # GPS dropouts
            $minLat = [Math]::Min($minLat, $lat); $maxLat = [Math]::Max($maxLat, $lat)
            $minLon = [Math]::Min($minLon, $lon); $maxLon = [Math]::Max($maxLon, $lon)
        }
        if ($minLat -gt $maxLat) { continue }

        $cLat = ($minLat + $maxLat) / 2; $cLon = ($minLon + $maxLon) / 2
        $hM = ($maxLat - $minLat) * 111320
        $wM = ($maxLon - $minLon) * 111320 * [Math]::Cos($cLat * [Math]::PI / 180)
        # Fit a 16:9 frame with 25% margin
        $range = [Math]::Max([Math]::Max($wM, $hM * 16 / 9) / (2 * [Math]::Tan($halfFov)) * 1.25, $TourMinRangeMeters)

        # Zoom out to fit the new flight before it starts drawing
        & $flyTo $TourZoomSeconds $t.Whens[0]
        # Trace it with the camera held still
        $n = $t.Coords.Count
        for ($s = 1; $s -le $TourTraceSteps; $s++) {
            & $flyTo ($TourTraceSeconds / $TourTraceSteps) $t.Whens[[int][Math]::Round(($n - 1) * $s / $TourTraceSteps)]
        }
    }
    $w.WriteLine('<gx:Wait><gx:duration>3</gx:duration></gx:Wait>')
    $w.WriteLine('</gx:Playlist></gx:Tour>')
}

$outFull = [IO.Path]::GetFullPath($OutputFile)
$files = @(Get-ChildItem -LiteralPath $InputDir -File |
    Where-Object { $_.Extension -match '^\.(csv|kml)$' -and $_.FullName -ne $outFull } |
    Sort-Object Name)

$tracks = New-Object System.Collections.Generic.List[object]
$skipped = New-Object System.Collections.Generic.List[string]

# Second pass re-tries files that failed to read the first time (transient locks)
$pending = $files
for ($pass = 1; $pass -le 2 -and $pending.Count; $pass++) {
  if ($pass -gt 1) { Start-Sleep -Seconds 3 }
  $retry = New-Object System.Collections.Generic.List[object]
  foreach ($file in $pending) {
    Write-Progress -Activity "Reading telemetry (pass $pass)" -Status $file.Name -PercentComplete (100 * $tracks.Count / [Math]::Max(1, $files.Count))
    try {
        $text = Read-AllTextWithRetry $file.FullName
        $t = if ($file.Extension -ieq '.csv') { Get-CsvTrack $text } else { Get-KmlTrack $text }
        if ($t.Coords.Count -lt 2) { $skipped.Add("$($file.Name) (no track points)"); continue }

        $hasTime = ($t.Whens.Count -eq $t.Coords.Count) -and -not ($t.Whens -contains '')
        $start = $null
        if ($hasTime) {
            $parsed = [datetime]::MinValue
            if ([datetime]::TryParse($t.Whens[0], $inv, [Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$parsed)) { $start = $parsed }
        }
        $allZeroAlt = $true
        foreach ($c in $t.Coords) {
            $p = $c.Split(' '); $a = 0.0
            if ($p.Length -ge 3 -and [double]::TryParse($p[2], [Globalization.NumberStyles]::Float, $inv, [ref]$a) -and $a -ne 0) { $allZeroAlt = $false; break }
        }

        $tracks.Add([pscustomobject]@{
            File = $file.Name; Id = $file.BaseName; Tail = $t.Name; Start = $start
            HasTime = $hasTime; ClampToGround = $allZeroAlt; Whens = $t.Whens; Coords = $t.Coords
        })
    }
    catch {
        $isLock = $_.Exception.InnerException -is [UnauthorizedAccessException] -or $_.Exception.InnerException -is [IO.IOException] -or
                  $_.Exception -is [UnauthorizedAccessException] -or $_.Exception -is [IO.IOException]
        if ($isLock -and $pass -eq 1) { $retry.Add($file) }
        else { $skipped.Add("$($file.Name) ($($_.Exception.Message))") }
    }
  }
  $pending = $retry
}
Write-Progress -Activity 'Reading telemetry' -Completed

$tracks = @($tracks | Sort-Object @{ Expression = { if ($_.Start) { $_.Start } else { [datetime]::MaxValue } } }, File)

$w = New-Object IO.StreamWriter($OutputFile, $false, (New-Object Text.UTF8Encoding($false)))
try {
    $w.WriteLine('<?xml version="1.0" encoding="UTF-8"?>')
    $w.WriteLine('<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">')
    $w.WriteLine('<Document>')
    $w.WriteLine('<name>MyFlightbook telemetry</name>')
    $w.WriteLine("<description>$($tracks.Count) flights combined $(Get-Date -Format 'yyyy-MM-dd')</description>")
    for ($i = 0; $i -lt $palette.Count; $i++) {
        $w.WriteLine("<Style id=`"c$i`"><LineStyle><color>$($palette[$i])</color><width>3</width></LineStyle>" +
            '<IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/shapes/airports.png</href></Icon></IconStyle></Style>')
    }
    $w.WriteLine('<Folder><name>Flights</name>')

    $i = 0
    foreach ($t in $tracks) {
        $label = if ($t.Start) { $t.Start.ToString('yyyy-MM-dd HH:mm', $inv) + 'Z' } else { $t.Id }
        if ($t.Tail) { $label += " $($t.Tail)" }
        $altMode = if ($t.ClampToGround) { 'clampToGround' } else { 'absolute' }

        $w.WriteLine('<Placemark>')
        $w.WriteLine("<name>$(Escape-Xml $label)</name>")
        $w.WriteLine("<description>Source: $(Escape-Xml $t.File), $($t.Coords.Count) points</description>")
        $w.WriteLine("<styleUrl>#c$($i % $palette.Count)</styleUrl>")
        if ($t.HasTime) {
            $w.WriteLine("<gx:Track><altitudeMode>$altMode</altitudeMode>")
            foreach ($when in $t.Whens) { $w.WriteLine("<when>$when</when>") }
            foreach ($c in $t.Coords) { $w.WriteLine("<gx:coord>$c</gx:coord>") }
            $w.WriteLine('</gx:Track>')
        }
        else {
            $w.WriteLine("<LineString><tessellate>1</tessellate><altitudeMode>$altMode</altitudeMode><coordinates>")
            foreach ($c in $t.Coords) { $w.WriteLine(($c -replace ' ', ',')) }
            $w.WriteLine('</coordinates></LineString>')
        }
        $w.WriteLine('</Placemark>')
        $i++
    }
    $w.WriteLine('</Folder>')
    if ($TourTraceSeconds -gt 0) { Write-Tour $w $tracks }
    $w.WriteLine('</Document></kml>')
}
finally { $w.Dispose() }

Write-Host "Wrote $($tracks.Count) tracks to $OutputFile"
if ($skipped.Count) {
    Write-Warning "Skipped $($skipped.Count) file(s):"
    $skipped | ForEach-Object { Write-Warning "  $_" }
}
