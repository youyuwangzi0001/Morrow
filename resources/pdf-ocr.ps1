param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$Pages,
  [Parameter(Mandatory = $true)][string]$OutPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$pageList = @(
  $Pages.Split(',') |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -match '^\d+$' } |
    ForEach-Object { [int]$_ } |
    Where-Object { $_ -ge 1 } |
    Select-Object -Unique
)

function Get-ErrorText($err) {
  $message = $err.Exception.Message
  $inner = $err.Exception.InnerException
  $depth = 0
  while ($inner -and $depth -lt 4) {
    $message = $message + ' <- ' + $inner.Message
    $inner = $inner.InnerException
    $depth++
  }
  return $message
}

function Write-Result($value) {
  $json = $value | ConvertTo-Json -Depth 6 -Compress
  [System.IO.File]::WriteAllText($OutPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
})[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
})[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

function Await-Action($Action) {
  $netTask = $asTaskAction.Invoke($null, @($Action))
  $netTask.Wait(-1) | Out-Null
}

try {
  [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

  # 从内存流加载：不依赖 WinRT 的文件访问许可，受限账户也能识别。
  $pdfBytes = [Convert]::FromBase64String(([System.IO.File]::ReadAllText($InputPath)).Trim())
  $pdfStream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $writer = New-Object Windows.Storage.Streams.DataWriter($pdfStream)
  $writer.WriteBytes($pdfBytes)
  $null = Await ($writer.StoreAsync()) ([uint32])
  $writer.DetachStream() | Out-Null
  $pdfStream.Seek(0)
  $document = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromStreamAsync($pdfStream)) ([Windows.Data.Pdf.PdfDocument])
  $totalPages = [int]$document.PageCount

  $languageTag = ''
  $engine = $null
  foreach ($tag in @('zh-Hans-CN', 'zh-Hans', 'en-US')) {
    try {
      $language = New-Object Windows.Globalization.Language($tag)
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
      if ($engine) { $languageTag = $language.LanguageTag; break }
    } catch {
      $engine = $null
    }
  }
  if (-not $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($engine) { $languageTag = $engine.RecognizerLanguage.LanguageTag }
  }
  if (-not $engine) {
    Write-Result @{ error = '本机没有可用的 Windows OCR 语言包'; totalPages = $totalPages; language = ''; engine = ''; pages = @() }
    exit 2
  }

  $results = @()
  foreach ($pageNumber in $pageList) {
    if ($pageNumber -gt $totalPages) {
      $results += @{ page = $pageNumber; text = ''; error = '页码超出范围' }
      continue
    }
    $page = $null
    $stream = $null
    $bitmap = $null
    try {
      $page = $document.GetPage([uint32]($pageNumber - 1))
      $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
      $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
      $options.DestinationWidth = [uint32]1800
      Await-Action ($page.RenderToStreamAsync($stream, $options))
      $stream.Seek(0)

      # 直接把渲染流交给 OCR，不落盘，也不需要额外文件权限。
      $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $ocrResult = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $text = ($ocrResult.Lines | ForEach-Object { $_.Text }) -join "`n"
      $results += @{ page = $pageNumber; text = $text }
    } catch {
      $results += @{ page = $pageNumber; text = ''; error = (Get-ErrorText $_) }
    } finally {
      if ($bitmap) { try { $bitmap.Dispose() } catch {} }
      if ($stream) { try { $stream.Dispose() } catch {} }
      if ($page) { try { $page.Dispose() } catch {} }
    }
  }

  Write-Result @{
    totalPages = $totalPages
    language = $languageTag
    engine = 'Windows.Media.Ocr'
    pages = $results
  }
} catch {
  Write-Result @{
    error = (Get-ErrorText $_)
    totalPages = 0
    language = ''
    engine = 'Windows.Media.Ocr'
    pages = @()
  }
  exit 1
}
