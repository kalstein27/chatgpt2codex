param(
    [Parameter(Mandatory = $true)][string]$OutputIco,
    [string]$OutputPng,
    [string]$SourceSvg = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($SourceSvg)) {
    $SourceSvg = Join-Path $repoRoot "assets\chatgpt2codex-icon.svg"
}
$SourceSvg = (Resolve-Path -LiteralPath $SourceSvg).Path
$svgSource = Get-Content -Raw -LiteralPath $SourceSvg
foreach ($marker in @("#087E78", "#119B93", "#20B6AD", "#FF9C14", "#FF7A00", "M514 171", "M720 596", "M755 758")) {
    if ($svgSource -notlike "*$marker*") { throw "Brand SVG is missing expected marker: $marker" }
}

function New-RoundedRectPath {
    param([single]$X, [single]$Y, [single]$Width, [single]$Height, [single]$Radius)
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = $Radius * 2.0
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-BrandBitmap {
    param([int]$Size)

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $scale = [single]($Size / 1024.0)
        $graphics.ScaleTransform($scale, $scale)

        $bgRect = [System.Drawing.RectangleF]::new(28, 28, 968, 968)
        $bgPath = New-RoundedRectPath -X 28 -Y 28 -Width 968 -Height 968 -Radius 210
        $bgBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
            $bgRect,
            [System.Drawing.ColorTranslator]::FromHtml("#087E78"),
            [System.Drawing.ColorTranslator]::FromHtml("#20B6AD"),
            45.0
        )
        try { $graphics.FillPath($bgBrush, $bgPath) } finally { $bgBrush.Dispose(); $bgPath.Dispose() }

        $whitePen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 64)
        $whitePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $whitePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $whitePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        try {
            $chat = [System.Drawing.Drawing2D.GraphicsPath]::new()
            try {
                $chat.StartFigure()
                $chat.AddBezier(514,171,321,171,176,308,176,491)
                $chat.AddBezier(176,491,176,594,225,684,306,744)
                $chat.AddLine(306,744,286,842)
                $chat.AddLine(286,842,405,777)
                $chat.AddBezier(405,777,440,786,476,791,514,791)
                $chat.AddBezier(514,791,705,791,852,655,852,476)
                $chat.AddBezier(852,476,852,299,706,171,514,171)
                $chat.CloseFigure()
                $graphics.DrawPath($whitePen, $chat)
            } finally { $chat.Dispose() }

            $graphics.DrawLines($whitePen, [System.Drawing.PointF[]]@(
                [System.Drawing.PointF]::new(426,388),
                [System.Drawing.PointF]::new(334,480),
                [System.Drawing.PointF]::new(426,572)
            ))
            $graphics.DrawLines($whitePen, [System.Drawing.PointF[]]@(
                [System.Drawing.PointF]::new(602,388),
                [System.Drawing.PointF]::new(694,480),
                [System.Drawing.PointF]::new(602,572)
            ))
            $graphics.DrawLine($whitePen, 552,349,476,611)
        } finally { $whitePen.Dispose() }

        $shield = [System.Drawing.Drawing2D.GraphicsPath]::new()
        try {
            $shield.StartFigure()
            $shield.AddBezier(720,596,789,620,850,618,905,596)
            $shield.AddLine(905,596,919,610)
            $shield.AddLine(919,610,919,738)
            $shield.AddBezier(919,738,919,833,858,895,812,919)
            $shield.AddBezier(812,919,766,895,705,833,705,738)
            $shield.AddLine(705,738,705,610)
            $shield.CloseFigure()

            $shieldRect = [System.Drawing.RectangleF]::new(705,596,214,323)
            $shieldBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
                $shieldRect,
                [System.Drawing.ColorTranslator]::FromHtml("#FF9C14"),
                [System.Drawing.ColorTranslator]::FromHtml("#FF7A00"),
                90.0
            )
            $shieldPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#FFD13A"), 26)
            $shieldPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
            try {
                $graphics.FillPath($shieldBrush, $shield)
                $graphics.DrawPath($shieldPen, $shield)
            } finally { $shieldBrush.Dispose(); $shieldPen.Dispose() }
        } finally { $shield.Dispose() }

        $checkPen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 42)
        $checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $checkPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        try {
            $graphics.DrawLines($checkPen, [System.Drawing.PointF[]]@(
                [System.Drawing.PointF]::new(755,758),
                [System.Drawing.PointF]::new(799,802),
                [System.Drawing.PointF]::new(873,718)
            ))
        } finally { $checkPen.Dispose() }
    } finally {
        $graphics.Dispose()
    }
    return $bitmap
}

function Get-PngBytes {
    param([int]$Size)
    $bitmap = New-BrandBitmap -Size $Size
    try {
        $stream = [System.IO.MemoryStream]::new()
        try {
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            return $stream.ToArray()
        } finally { $stream.Dispose() }
    } finally { $bitmap.Dispose() }
}

$icoDir = Split-Path -Parent $OutputIco
if ($icoDir) { [System.IO.Directory]::CreateDirectory($icoDir) | Out-Null }

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()
foreach ($size in $sizes) { $images += ,(Get-PngBytes -Size $size) }

$stream = [System.IO.File]::Open($OutputIco, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
$writer = [System.IO.BinaryWriter]::new($stream)
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Count)
    $offset = 6 + (16 * $sizes.Count)
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $size = [int]$sizes[$i]
        $dim = if ($size -ge 256) { [byte]0 } else { [byte]$size }
        $writer.Write($dim)
        $writer.Write($dim)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$images[$i].Length)
        $writer.Write([uint32]$offset)
        $offset += $images[$i].Length
    }
    foreach ($image in $images) { $writer.Write([byte[]]$image) }
} finally {
    $writer.Dispose()
    $stream.Dispose()
}

if ($OutputPng) {
    $pngDir = Split-Path -Parent $OutputPng
    if ($pngDir) { [System.IO.Directory]::CreateDirectory($pngDir) | Out-Null }
    $png = New-BrandBitmap -Size 1024
    try { $png.Save($OutputPng, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $png.Dispose() }
}

Write-Host "brand-icon=PASS"
Write-Host "source-svg=$SourceSvg"
Write-Host "ico=$OutputIco"
if ($OutputPng) { Write-Host "png=$OutputPng" }
