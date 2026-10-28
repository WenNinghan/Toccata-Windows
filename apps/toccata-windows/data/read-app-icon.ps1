# One bounded, read-only icon request. Paths arrive over stdin and are never logged.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false

function Get-PackagePath([string]$Root, [string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or $Relative.Contains(':') -or
        [IO.Path]::IsPathRooted($Relative) -or $Relative.IndexOfAny([char[]]"`r`n`0") -ge 0) { return $null }
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $candidate = [IO.Path]::GetFullPath([IO.Path]::Combine($prefix, $Relative.Replace('/', '\')))
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    # Refuse links/junctions inside a package, including its root, so a logo cannot escape it.
    $part = $candidate
    while ($part.Length -ge $prefix.Length - 1) {
        if (([IO.File]::Exists($part) -or [IO.Directory]::Exists($part)) -and
            ([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
        $part = [IO.Path]::GetDirectoryName($part)
        if (-not $part) { break }
    }
    return $candidate
}

function Convert-IconImage([Drawing.Image]$Image, [Drawing.Color]$Background, [bool]$Plate) {
    if ($Image.Width -le 0 -or $Image.Height -le 0 -or $Image.Width -gt 2048 -or $Image.Height -gt 2048) { return $null }
    $bitmap = $null; $graphics = $null; $stream = $null
    try {
        $bitmap = New-Object Drawing.Bitmap 128, 128, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $graphics.Clear($Background)
        $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        # Unplated package logos need a little breathing room on their manifest background.
        $extent = if ($Plate) { 104 } else { 128 }
        $ratio = [Math]::Min($extent / $Image.Width, $extent / $Image.Height)
        $width = [int][Math]::Round($Image.Width * $ratio)
        $height = [int][Math]::Round($Image.Height * $ratio)
        $rect = New-Object Drawing.Rectangle ([int]((128 - $width) / 2)), ([int]((128 - $height) / 2)), $width, $height
        $graphics.DrawImage($Image, $rect, 0, 0, $Image.Width, $Image.Height, [Drawing.GraphicsUnit]::Pixel)
        $stream = New-Object IO.MemoryStream
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        if ($stream.Length -gt 262144) { return $null }
        return [Convert]::ToBase64String($stream.ToArray())
    } finally {
        if ($stream) { $stream.Dispose() }
        if ($graphics) { $graphics.Dispose() }
        if ($bitmap) { $bitmap.Dispose() }
    }
}

function Get-PackageIcon([string]$ExePath) {
    $directory = [IO.Path]::GetDirectoryName($ExePath)
    for ($depth = 0; $depth -lt 6 -and $directory; $depth++) {
        $manifest = [IO.Path]::Combine($directory, 'AppxManifest.xml')
        if ([IO.File]::Exists($manifest)) {
            $reader = $null
            try {
                if ((Get-Item -LiteralPath $manifest).Length -gt 2097152) { return $null }
                $settings = New-Object Xml.XmlReaderSettings
                $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
                $settings.XmlResolver = $null
                $settings.MaxCharactersInDocument = 2097152
                $reader = [Xml.XmlReader]::Create($manifest, $settings)
                $document = New-Object Xml.XmlDocument
                $document.XmlResolver = $null
                $document.Load($reader)
                foreach ($application in $document.SelectNodes('/*[local-name()="Package"]/*[local-name()="Applications"]/*[local-name()="Application"]')) {
                    $executable = Get-PackagePath $directory $application.GetAttribute('Executable')
                    if (-not $executable -or -not $executable.Equals($ExePath, [StringComparison]::OrdinalIgnoreCase)) { continue }
                    $visual = $application.SelectSingleNode('*[local-name()="VisualElements"]')
                    if (-not $visual) { return $null }
                    $background = [Drawing.Color]::White
                    $color = $visual.GetAttribute('BackgroundColor')
                    if ($color -and $color -ne 'transparent') {
                        try { $background = [Drawing.ColorTranslator]::FromHtml($color) } catch { }
                    }
                    foreach ($attribute in @('Square44x44Logo', 'Square150x150Logo')) {
                        $relative = $visual.GetAttribute($attribute)
                        if (-not $relative -or [IO.Path]::GetExtension($relative) -ine '.png') { continue }
                        # The unqualified file need not exist when resources only have scale/target qualifiers.
                        $relativeDirectory = [IO.Path]::GetDirectoryName($relative.Replace('/', '\'))
                        $assetDirectory = if ($relativeDirectory) { Get-PackagePath $directory $relativeDirectory } else { $directory }
                        if (-not $assetDirectory -or -not [IO.Directory]::Exists($assetDirectory)) { continue }
                        $stem = [IO.Path]::GetFileNameWithoutExtension($relative)
                        $candidates = @()
                        foreach ($size in @(128, 256, 96, 64, 48)) {
                            $forms = if ($background.GetBrightness() -lt 0.6) { @('_altform-unplated', '', '_altform-lightunplated') } else { @('_altform-lightunplated', '', '_altform-unplated') }
                            foreach ($form in $forms) { $candidates += "$stem.targetsize-$size$form.png" }
                        }
                        $candidates += @("$stem.scale-400.png", "$stem.scale-200.png", "$stem.scale-150.png", "$stem.png")
                        foreach ($filename in $candidates) {
                            $candidate = [IO.Path]::Combine($assetDirectory, $filename)
                            if (-not [IO.File]::Exists($candidate)) { continue }
                            $candidate = Get-PackagePath $directory $candidate.Substring($directory.TrimEnd('\').Length + 1)
                            if (-not $candidate -or (Get-Item -LiteralPath $candidate).Length -gt 4194304) { continue }
                            $image = $null
                            try {
                                $image = [Drawing.Image]::FromFile($candidate)
                                $png = Convert-IconImage $image $background ($filename -like '*targetsize*')
                                if ($png) { return @{ png = $png; source = 'package'; width = 128; height = 128 } }
                            } finally { if ($image) { $image.Dispose() } }
                        }
                    }
                }
            } catch { return $null } finally { if ($reader) { $reader.Dispose() } }
            return $null
        }
        $directory = [IO.Path]::GetDirectoryName($directory)
    }
    return $null
}

function Get-ExecutableIcon([string]$ExePath) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ToccataIconResource {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern uint PrivateExtractIcons(string file, int index, int width, int height,
        IntPtr[] icons, uint[] ids, uint count, uint flags);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DestroyIcon(IntPtr icon);
    public static IntPtr Extract(string file) {
        var icons = new IntPtr[1]; var ids = new uint[1];
        uint count = PrivateExtractIcons(file, 0, 256, 256, icons, ids, 1, 0);
        if (count == 1 && icons[0] != IntPtr.Zero) return icons[0];
        if (icons[0] != IntPtr.Zero) DestroyIcon(icons[0]);
        return IntPtr.Zero;
    }
    public static void Release(IntPtr icon) { if (icon != IntPtr.Zero) DestroyIcon(icon); }
}
'@
    $handle = [IntPtr]::Zero; $icon = $null; $bitmap = $null
    try {
        $handle = [ToccataIconResource]::Extract($ExePath)
        if ($handle -eq [IntPtr]::Zero) { return $null }
        $icon = [Drawing.Icon]::FromHandle($handle)
        $bitmap = $icon.ToBitmap()
        $png = Convert-IconImage $bitmap ([Drawing.Color]::Transparent) $false
        if ($png) { return @{ png = $png; source = 'executable'; width = 128; height = 128 } }
    } finally {
        if ($bitmap) { $bitmap.Dispose() }
        if ($icon) { $icon.Dispose() }
        [ToccataIconResource]::Release($handle)
    }
    return $null
}

try {
    $inputText = [Console]::In.ReadToEnd()
    if ($inputText.Length -gt 32768) { throw 'Invalid request' }
    $request = $inputText | ConvertFrom-Json
    if ($request.exePath -isnot [string] -or $request.exePath -notmatch '^[A-Za-z]:[\\/]' -or
        $request.exePath -match '[\x00-\x1f]' -or [IO.Path]::GetExtension($request.exePath) -ine '.exe') { throw 'Invalid request' }
    $exe = [IO.Path]::GetFullPath($request.exePath)
    if (-not [IO.File]::Exists($exe)) { throw 'Unavailable executable' }
    Add-Type -AssemblyName System.Drawing
    $result = Get-PackageIcon $exe
    if (-not $result) { $result = Get-ExecutableIcon $exe }
    if ($result) { [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress)) }
    else { [Console]::Out.WriteLine('null') }
} catch {
    [Console]::Out.WriteLine('null')
}
