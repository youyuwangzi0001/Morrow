"""生成创作台样例音频（仅开发期使用）：
- music-rain.wav：本地程序化配乐
- sfx-*.wav：雨声 / 伞骨 / 心跳
- voice-NN.wav：Windows SAPI 中文配音
"""
import math
import os
import random
import subprocess
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'resources' / 'studio-demo'
TMP = ROOT / 'tmp' / 'studio-audio'
OUT.mkdir(parents=True, exist_ok=True)
TMP.mkdir(parents=True, exist_ok=True)
SR = 32000
random.seed(20261026)
np.random.seed(20261026)


def write_wav(path: Path, left: np.ndarray, right: np.ndarray, sr: int = SR) -> None:
    data = np.stack([left, right], axis=1)
    data = np.clip(data, -1, 1)
    pcm = (data * 32767).astype('<i2')
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes(pcm.tobytes())


def midi(note: float) -> float:
    return 440.0 * (2.0 ** ((note - 69) / 12.0))


def add_piano(buf_l, buf_r, start, duration, note, velocity, pan=0.0, sr=SR):
    freq = midi(note)
    n = int(duration * sr)
    s = int(start * sr)
    if s >= len(buf_l):
        return
    n = min(n, len(buf_l) - s)
    t = np.arange(n) / sr
    attack = np.minimum(1.0, t / 0.012)
    decay = np.exp(-t * (1.75 + 60.0 / max(1.0, note)))
    body = (
        np.sin(2 * np.pi * freq * t) * 0.62
        + np.sin(2 * np.pi * freq * 2 * t) * 0.16
        + np.sin(2 * np.pi * freq * 3 * t) * 0.06
        + np.sin(2 * np.pi * freq * 4.01 * t) * 0.025
    )
    value = body * attack * decay * velocity
    pl = math.cos((pan + 1) * math.pi / 4)
    pr = math.sin((pan + 1) * math.pi / 4)
    buf_l[s:s + n] += value * pl
    buf_r[s:s + n] += value * pr


def add_pad(buf_l, buf_r, start, duration, notes, velocity, sr=SR):
    n = int(duration * sr)
    s = int(start * sr)
    if s >= len(buf_l):
        return
    n = min(n, len(buf_l) - s)
    t = np.arange(n) / sr
    env = np.minimum(1.0, t / 1.4) * np.minimum(1.0, (duration - t) / 1.6) * velocity
    for note in notes:
        freq = midi(note)
        value = (np.sin(2 * np.pi * freq * t) + np.sin(2 * np.pi * freq * 1.005 * t) * 0.5) * env * 0.06
        buf_l[s:s + n] += value
        buf_r[s:s + n] += value


def make_music(path: Path, seconds: float = 54.0) -> None:
    frames = int(seconds * SR)
    left = np.zeros(frames, dtype=np.float64)
    right = np.zeros(frames, dtype=np.float64)
    tempo = 58
    bar = (60.0 / tempo) * 4
    chords = [
        [50, 53, 57, 62],
        [46, 50, 53, 58],
        [43, 46, 50, 55],
        [45, 49, 52, 57],
    ]
    melody = [74, 72, 69, 67, 69, 72, 74, 77]
    bar_index = 0
    time = 0.0
    while time < seconds + bar:
        chord = chords[bar_index % len(chords)]
        add_pad(left, right, time, min(bar * 1.15, seconds - time + 1), chord, 0.9)
        add_piano(left, right, time, min(3.6, seconds - time), chord[0] - 12, 0.22, -0.2)
        pattern = [0, 2, 1, 3, 1, 2, 0, 2]
        for step, idx in enumerate(pattern):
            at = time + (bar / len(pattern)) * step
            if at >= seconds:
                break
            add_piano(left, right, at, 2.4, chord[idx] + 12, 0.11 + random.random() * 0.05, (random.random() - 0.5) * 0.6)
        if bar_index % 2 == 0:
            note = melody[(bar_index // 2) % len(melody)]
            add_piano(left, right, time + bar * 0.5, 3.2, note, 0.17, 0.25)
            if bar_index % 4 == 2:
                add_piano(left, right, time + bar * 0.75, 2.4, note - 3, 0.1, -0.3)
        time += bar
        bar_index += 1
    # 雨声：低通白噪声 + 稀疏水滴
    noise = np.random.normal(0, 1, frames)
    rain = np.zeros(frames)
    filtered = 0.0
    for i in range(frames):
        filtered = filtered * 0.985 + noise[i] * 0.015
        rain[i] = filtered * 0.16
    left += rain
    right += rain * 0.95
    for _ in range(int(seconds * 1.2)):
        start = np.random.randint(0, max(1, frames - int(0.2 * SR)))
        freq = 900 + random.random() * 2200
        length = int(SR * (0.04 + random.random() * 0.08))
        t = np.arange(length) / SR
        value = np.sin(2 * np.pi * freq * t) * np.exp(-t * 60) * (0.02 + random.random() * 0.035)
        left[start:start + length] += value
        right[start:start + length] += value * 0.85
    delay = int(SR * 0.23)
    left[delay:] += left[:-delay] * 0.09
    right[delay:] += right[:-delay] * 0.11
    fade = int(SR * 2.5)
    ramp = np.linspace(0, 1, fade)
    left[:fade] *= ramp
    right[:fade] *= ramp
    left[-fade:] *= ramp[::-1]
    right[-fade:] *= ramp[::-1]
    peak = max(np.max(np.abs(left)), np.max(np.abs(right)), 1e-9)
    left *= 0.72 / peak
    right *= 0.72 / peak
    write_wav(path, left, right)
    print('music', path, round(seconds, 1), 's')


def make_rain(path: Path, seconds: float = 10.0) -> None:
    frames = int(seconds * SR)
    noise = np.random.normal(0, 1, frames)
    filtered = np.zeros(frames)
    acc = 0.0
    for i in range(frames):
        acc = acc * 0.985 + noise[i] * 0.015
        filtered[i] = acc
    left = filtered * 0.55
    right = filtered * 0.5
    for _ in range(int(seconds * 1.5)):
        start = np.random.randint(0, frames - int(0.1 * SR))
        freq = 900 + random.random() * 2000
        length = int(SR * 0.07)
        t = np.arange(length) / SR
        value = np.sin(2 * np.pi * freq * t) * np.exp(-t * 60) * 0.04
        left[start:start + length] += value
        right[start:start + length] += value * 0.8
    write_wav(path, left, right)


def make_umbrella(path: Path, seconds: float = 4.0) -> None:
    frames = int(seconds * SR)
    left = np.zeros(frames)
    right = np.zeros(frames)
    for click in range(7):
        start = int((0.18 + click * 0.48) * SR)
        freq = 2600 + random.random() * 1800
        length = int(0.08 * SR)
        t = np.arange(length) / SR
        value = (np.sin(2 * np.pi * freq * t) + np.random.random(length) * 0.4) * np.exp(-t * 45) * 0.09
        if start + length < frames:
            left[start:start + length] += value
            right[start:start + length] += value * 0.8
    noise = np.random.normal(0, 1, frames) * 0.012
    left += noise
    right += noise
    write_wav(path, left, right)


def make_heartbeat(path: Path, seconds: float = 6.0) -> None:
    frames = int(seconds * SR)
    t = np.arange(frames) / SR
    beat = t % 0.86
    def thump(offset, gain):
        x = beat - offset
        return np.where((x >= 0) & (x <= 0.22), np.sin(2 * np.pi * 52 * x) * np.exp(-x * 28) * gain, 0)
    value = thump(0, 0.5) + thump(0.22, 0.28)
    left = value
    right = value * 0.9
    write_wav(path, left, right)


VOICES = {
    'voice-03.wav': ('还能修好吗？', -1),
    'voice-04.wav': ('你每周三都来，是为了它，还是为了别的？', 0),
    'voice-06.wav': ('修不好，也没关系。', -3),
    'voice-07.wav': ('这把伞，能把时间倒着走。', 0),
    'voice-08.wav': ('你认识她，对吗？', -1),
    'voice-09.wav': ('我好像，正在忘记她。', -1),
    'voice-11.wav': ('这次，别再弄丢了。', 0),
}

PS = r'''
param([string]$VoiceName,[string]$Out,[string]$TextFile,[int]$Rate=0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$installed = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
$pick = $VoiceName
if (-not ($installed -contains $pick)) {
  $pick = $installed | Where-Object { $_ -like '*Huihui*' } | Select-Object -First 1
}
if (-not $pick) { $pick = $installed | Select-Object -First 1 }
if ($pick) { $s.SelectVoice($pick) }
$s.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
$s.Volume = 100
$s.SetOutputToWaveFile($Out)
$s.Speak($text)
$s.Dispose()
Write-Output "OK $pick"
'''

def make_voices() -> None:
    script = TMP / 'speak.ps1'
    script.write_text('\ufeff' + PS, encoding='utf-8')
    for filename, (text, rate) in VOICES.items():
        text_file = TMP / (filename + '.txt')
        text_file.write_text(text, encoding='utf-8')
        out = OUT / filename
        result = subprocess.run(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(script), '-VoiceName', 'Microsoft Huihui Desktop', '-Out', str(out), '-TextFile', str(text_file), '-Rate', str(rate)],
            capture_output=True, text=True, encoding='utf-8', timeout=120
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr or result.stdout)
        print('voice', filename, result.stdout.strip())


make_music(OUT / 'music-rain.wav', 54)
make_rain(OUT / 'sfx-rain.wav')
make_umbrella(OUT / 'sfx-umbrella.wav')
make_heartbeat(OUT / 'sfx-heartbeat.wav')
make_voices()
print('audio complete')
