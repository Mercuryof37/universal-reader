<#
================================================================================
 win-ocr-helper.ps1  —  Windows 内置 OCR (WinRT Windows.Media.Ocr) 命令行助手
================================================================================

【用途】
  把一个或多个本地图片文件交给 **Windows 系统自带的 OCR 引擎**识别，并把识别结果
  （按行 + 每个词的文字与包围盒）写成 UTF-8 JSON 文件。
  它是 `win-ocr-pdf.mjs` 的底层执行体，也可以单独用来 OCR 单张图片。

  为什么用「写 JSON 文件」而不是「往 stdout 打 JSON」：
    DSH 沙箱禁止子进程通过管道 (named pipe) 捕获输出 —— Node 的
    child_process.spawn / exec 用默认 stdio:'pipe' 会 EPERM。
    改成「PowerShell 写文件 → Node 读文件」，任何环境下都能跑，且不依赖管道。

【前置条件】（零额外安装，全部是 Windows 自带）
  1. Windows 10 / 11（本脚本在 Windows 11 build 26300 上实测通过）
  2. Windows PowerShell 5.1（powershell.exe）。
     ⚠ 不要用 PowerShell 7 (pwsh)：PS7 默认没有 WinRT 类型投影，
       `[Windows.Media.Ocr.OcrEngine]` 会加载失败。本脚本会拒绝在 PS7 下运行。
  3. 已安装 OCR 语言包。中文需要 `zh-Hans-CN`。
     检查：本脚本 -ListLanguages 参数，或
       Get-WindowsCapability -Online -Name "Language.OCR*"
     安装：设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 →
           可选语言功能 → 「光学字符识别」
  4. 无需管理员权限、无需联网。

【用法】
  # 列出本机可用的 OCR 语言
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File win-ocr-helper.ps1 -ListLanguages

  # OCR 一个目录下所有 page-*.png（按文件名排序），结果写到 result.json
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File win-ocr-helper.ps1 `
      -ImageDir .\tmp -OutFile .\result.json

  # OCR 单张图片
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File win-ocr-helper.ps1 `
      -ImagePath .\scan.png -OutFile .\result.json

  # 指定语言（默认 zh-Hans-CN）
  ... -Language en-US

【输出 JSON 结构】
  {
    "engineLanguage": "zh-Hans-CN",
    "maxImageDimension": 10000,
    "images": [
      { "image": "page-001.png", "width": 1654, "height": 2339,
        "lines": [ { "text": "识别出的一行字",
                     "words": [ {"t":"识","x":36.0,"y":27.0,"w":34.0,"h":34.0}, ... ] } ] }
    ],
    "errors": [ "..." ]
  }
  说明：`text` 是「按词拼接」后的结果（见下方 Join-WordText），
        与 WinRT `OcrLine.Text` 的原始值可能不同 —— WinRT 原始值会在
        每个汉字之间插空格，直接入库很难看。

【本脚本实测到哪一步】（2026-xx，Windows 11 10.0.26300，PowerShell 5.1）
  ✅ 已验证：WinRT 类型加载、AvailableRecognizerLanguages 枚举（本机只有 zh-Hans-CN）、
     引擎创建、图片解码 (BitmapDecoder)、RecognizeAsync、词级包围盒输出。
  ✅ 已验证：对 PNG 单图与多图批量识别的完整链路。
  ⚠ 未验证：非中文语言包（本机未装）、PDF 输入（本脚本只吃图片，PDF 渲染由 .mjs 负责）、
     手写体、超大图（>10000px 会被 MaxImageDimension 拒绝）。
================================================================================
#>

[CmdletBinding()]
param(
    # 单张图片路径
    [string]$ImagePath,

    # 目录：处理其中所有 *.png / *.jpg / *.jpeg / *.bmp / *.tif（按文件名排序）
    [string]$ImageDir,

    # 结果 JSON 输出路径
    [string]$OutFile,

    # OCR 语言标签，默认简体中文
    [string]$Language = 'zh-Hans-CN',

    # 只列出本机可用的 OCR 语言后退出
    [switch]$ListLanguages
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- PS7 守卫
if ($PSVersionTable.PSVersion.Major -ge 7) {
    Write-Error @"
本脚本必须在 Windows PowerShell 5.1 (powershell.exe) 下运行，当前是 PowerShell $($PSVersionTable.PSVersion)。
PowerShell 7 默认不提供 WinRT 类型投影，`[Windows.Media.Ocr.OcrEngine]` 无法加载。
请改用： powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$($MyInvocation.MyCommand.Path)"
"@
    exit 2
}

# ---------------------------------------------------------------- 加载 WinRT
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

# WinRT 的 IAsyncOperation<T> / IAsyncAction 没有 .NET 同步等价物，
# 需要用 WindowsRuntimeSystemExtensions.AsTask 反射桥接。
$script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($op, [Type]$resultType) {
    $task = $script:AsTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

# ---------------------------------------------------------------- 语言枚举
function Get-OcrLanguages {
    $out = @()
    foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
        $out += [pscustomobject]@{
            LanguageTag = $l.LanguageTag
            DisplayName = $l.DisplayName
            NativeName  = $l.NativeName
        }
    }
    , $out
}

if ($ListLanguages) {
    $langs = Get-OcrLanguages
    if ($langs.Count -eq 0) {
        Write-Output '没有安装任何 OCR 语言包。'
    }
    else {
        Write-Output ("可用的 OCR 语言（{0} 个）：" -f $langs.Count)
        $langs | ForEach-Object { Write-Output ("  {0,-14} {1}" -f $_.LanguageTag, $_.DisplayName) }
    }
    exit 0
}

# ---------------------------------------------------------------- 拼接一行文字
# WinRT 对 CJK 会逐字切词，`OcrLine.Text` 会在每个汉字之间插空格
# （实测："这 是 一 个 扫 描 版 PDF..."）。
# 规则：只有当「前一个词的末字符」和「后一个词的首字符」都不是 CJK/全角时，
#       才补一个空格。这样 "universal-reader" 与 "支持" 之间不插空格，
#       而 "English mixed" 之间保留空格。
function Test-CjkChar([char]$c) {
    $n = [int]$c
    return (
        ($n -ge 0x2E80 -and $n -le 0x303F) -or   # CJK 部首 + CJK 标点
        ($n -ge 0x3040 -and $n -le 0x30FF) -or   # 日文假名
        ($n -ge 0x3400 -and $n -le 0x4DBF) -or   # CJK 扩展 A
        ($n -ge 0x4E00 -and $n -le 0x9FFF) -or   # CJK 统一表意文字
        ($n -ge 0xF900 -and $n -le 0xFAFF) -or   # CJK 兼容表意文字
        ($n -ge 0xFF00 -and $n -le 0xFFEF)       # 全角/半角形式
    )
}

function Join-WordText($words) {
    $sb = New-Object System.Text.StringBuilder
    $prev = $null
    foreach ($w in $words) {
        $t = [string]$w.Text
        if ($t.Length -eq 0) { continue }
        if ($null -ne $prev) {
            $a = $prev[$prev.Length - 1]
            $b = $t[0]
            if (-not (Test-CjkChar $a) -and -not (Test-CjkChar $b)) {
                [void]$sb.Append(' ')
            }
        }
        [void]$sb.Append($t)
        $prev = $t
    }
    $sb.ToString()
}

# ---------------------------------------------------------------- 建引擎
$engine = $null
try {
    $lang = New-Object Windows.Globalization.Language $Language
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
}
catch {
    Write-Warning "创建 $Language 引擎时抛异常：$($_.Exception.Message)"
}
if ($null -eq $engine) {
    Write-Warning "本机没有 $Language 的 OCR 引擎，回退到用户配置文件语言。"
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if ($null -eq $engine) {
    $avail = (Get-OcrLanguages | ForEach-Object { $_.LanguageTag }) -join ', '
    Write-Error "找不到可用的 OCR 引擎。本机已安装的 OCR 语言：[${avail}]。请在「设置 → 时间和语言 → 语言和区域」中为该语言安装「光学字符识别」可选功能。"
    exit 3
}

$maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension

# ---------------------------------------------------------------- 收集输入
$files = @()
if ($ImagePath) {
    if (-not (Test-Path -LiteralPath $ImagePath)) { Write-Error "找不到图片：$ImagePath"; exit 4 }
    $files += (Resolve-Path -LiteralPath $ImagePath).Path
}
if ($ImageDir) {
    if (-not (Test-Path -LiteralPath $ImageDir)) { Write-Error "找不到目录：$ImageDir"; exit 4 }
    $files += (Get-ChildItem -LiteralPath $ImageDir -File |
            Where-Object { $_.Extension -match '^\.(png|jpg|jpeg|bmp|tif|tiff)$' } |
            Sort-Object Name | Select-Object -ExpandProperty FullName)
}
if ($files.Count -eq 0) { Write-Error '没有找到任何图片。请用 -ImagePath 或 -ImageDir 指定输入。'; exit 4 }

# ---------------------------------------------------------------- 逐张识别
$results = @()
$errors = @()
$sw = [System.Diagnostics.Stopwatch]::StartNew()

foreach ($f in $files) {
    try {
        $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($f)) ([Windows.Storage.StorageFile])
        $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

        if ($bitmap.PixelWidth -gt $maxDim -or $bitmap.PixelHeight -gt $maxDim) {
            $errors += "$([System.IO.Path]::GetFileName($f)): 尺寸 $($bitmap.PixelWidth)x$($bitmap.PixelHeight) 超过引擎上限 $maxDim，已跳过。"
            $stream.Dispose()
            continue
        }

        $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

        $lineArr = @()
        foreach ($line in $ocr.Lines) {
            $wordArr = @()
            foreach ($w in $line.Words) {
                $r = $w.BoundingRect
                $wordArr += [pscustomobject]@{
                    t = [string]$w.Text
                    x = [math]::Round($r.X, 1)
                    y = [math]::Round($r.Y, 1)
                    w = [math]::Round($r.Width, 1)
                    h = [math]::Round($r.Height, 1)
                }
            }
            $lineArr += [pscustomobject]@{
                text  = (Join-WordText $line.Words)
                raw   = [string]$line.Text
                words = $wordArr
            }
        }

        $results += [pscustomobject]@{
            image  = [System.IO.Path]::GetFileName($f)
            width  = $bitmap.PixelWidth
            height = $bitmap.PixelHeight
            lines  = $lineArr
        }

        $stream.Dispose()
        Write-Host ("  [OCR] {0}  ({1}x{2})  ->  {3} 行" -f [System.IO.Path]::GetFileName($f), $bitmap.PixelWidth, $bitmap.PixelHeight, $lineArr.Count)
    }
    catch {
        $errors += "$([System.IO.Path]::GetFileName($f)): $($_.Exception.Message)"
        Write-Warning "识别失败：$f — $($_.Exception.Message)"
    }
}
$sw.Stop()

# ---------------------------------------------------------------- 写 JSON
$payload = [pscustomobject]@{
    engineLanguage    = $engine.RecognizerLanguage.LanguageTag
    maxImageDimension = $maxDim
    elapsedMs         = $sw.ElapsedMilliseconds
    images            = $results
    errors            = $errors
}

$json = $payload | ConvertTo-Json -Depth 8

if ($OutFile) {
    $dir = Split-Path -Parent $OutFile
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    # 不带 BOM 的 UTF-8，避免 Node 侧读到 \uFEFF
    [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ("写出 {0}（{1} 张图，{2} ms）" -f $OutFile, $results.Count, $sw.ElapsedMilliseconds)
}
else {
    Write-Output $json
}

if ($errors.Count -gt 0) { exit 5 }
exit 0
