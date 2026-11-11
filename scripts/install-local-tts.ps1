# Morrow 本地 AI 声线安装（Qwen3-TTS 1.7B CustomVoice）
# 依赖：Windows 11 x64、Python 3.12、NVIDIA 显卡（建议 8GB+ 显存）、winget。
# 用法：powershell -ExecutionPolicy Bypass -File scripts/install-local-tts.ps1
$ErrorActionPreference = 'Stop'
$home = Join-Path $env:LOCALAPPDATA 'Morrow\local-tts'
$venv = Join-Path $home 'venv'
$python = Join-Path $venv 'Scripts\python.exe'
$model = Join-Path $home 'model'

Write-Host "[morrow-tts] 安装目录：$home"
New-Item -ItemType Directory -Force -Path $home | Out-Null
if (-not (Test-Path $python)) {
  Write-Host '[morrow-tts] 创建独立 Python 环境…'
  python -m venv $venv --system-site-packages
}
Write-Host '[morrow-tts] 安装推理依赖…'
& $python -m pip install --upgrade pip
& $python -m pip install --timeout 30 --retries 2 -i https://pypi.tuna.tsinghua.edu.cn/simple `
  torchaudio==2.11.0 transformers==4.57.3 accelerate==1.12.0 librosa soundfile sox onnxruntime einops modelscope
& $python -m pip install --timeout 30 --retries 2 -i https://pypi.tuna.tsinghua.edu.cn/simple qwen-tts==0.1.1 --no-deps

if (-not (Get-Command sox -ErrorAction SilentlyContinue)) {
  Write-Host '[morrow-tts] 安装 SoX 音频工具…'
  winget install --id ChrisBagwell.SoX -e --accept-source-agreements --accept-package-agreements --silent
}

if (-not (Test-Path (Join-Path $model 'model.safetensors'))) {
  Write-Host '[morrow-tts] 下载 Qwen3-TTS 1.7B 模型（约 4.3GB）…'
  & $python -c "from modelscope import snapshot_download; snapshot_download('Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', local_dir=r'$model')"
}
Write-Host '[morrow-tts] 完成。重启 Morrow 后，配音声线会自动使用本地 Qwen3-TTS。'
Write-Host "[morrow-tts] 模型：$model"
