"""生成《逆行的伞》96 秒样例草稿（仅开发期使用）。"""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEMO = ROOT / 'resources' / 'studio-demo'
TMP = ROOT / 'tmp' / 'studio-video'
TMP.mkdir(parents=True, exist_ok=True)

DURATIONS = [8, 8, 8, 7, 8, 8, 9, 8, 7, 9, 8, 8]
DIALOGUES = {
    3: ('还能修好吗？', 'voice-03.wav', 0.0),
    4: ('你每周三都来，是为了它，还是为了别的？', 'voice-04.wav', 0.2),
    6: ('修不好也没关系。', 'voice-06.wav', 0.3),
    7: ('这把伞，能把时间倒着走。', 'voice-07.wav', 0.2),
    8: ('你认识她，对吗？', 'voice-08.wav', 0.2),
    9: ('我好像，正在忘记她。', 'voice-09.wav', 0.2),
    11: ('这次，别再弄丢了。', 'voice-11.wav', 0.2),
}
STARTS = []
cursor = 0.0
for duration in DURATIONS:
    STARTS.append(cursor)
    cursor += duration
TOTAL = cursor


def run(args, **kwargs):
    print(' '.join(str(x) for x in args))
    result = subprocess.run(args, capture_output=True, text=True, encoding='utf-8', **kwargs)
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout)
    return result


segments = []
for index, duration in enumerate(DURATIONS):
    image = DEMO / f'drama-{index + 1:02d}.png'
    out = TMP / f'seg-{index + 1:02d}.mp4'
    fade = 0.25 if index in (0, len(DURATIONS) - 1) else 0.12
    vf = (
        f"scale=1056:594:force_original_aspect_ratio=increase:flags=lanczos,crop=1056:594,"
        f"zoompan=z='min(zoom+0.00042,1.085)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=960x540:fps=30,"
        f"trim=duration={duration},setpts=PTS-STARTPTS,"
        f"fade=t=in:st=0:d={fade},fade=t=out:st={duration - fade}:d={fade}"
    )
    run([
        'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
        '-loop', '1', '-framerate', '30', '-t', str(duration), '-i', str(image),
        '-vf', vf, '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
        '-pix_fmt', 'yuv420p', '-an', str(out)
    ])
    segments.append(out)

concat = TMP / 'concat.txt'
concat.write_text('\n'.join(f"file '{path.as_posix()}'" for path in segments), encoding='utf-8')
video = TMP / 'video.mp4'
run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(concat), '-c', 'copy', str(video)])

# 音频：配乐 + 雨声 + 伞骨 + 心跳 + 对白
audio_inputs = []
filters = []
mix_labels = []
index = 0

music = TMP / 'music.wav'
run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-stream_loop', '-1', '-i', str(DEMO / 'music-rain.wav'), '-t', str(TOTAL), '-af', 'volume=0.55,afade=t=in:st=0:d=2,afade=t=out:st=' + str(TOTAL - 3) + ':d=3', '-ar', '48000', '-ac', '2', str(music)])
audio_inputs += ['-i', str(music)]
mix_labels.append(f'[{index}:a]')
index += 1

rain = TMP / 'rain.wav'
run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-stream_loop', '-1', '-i', str(DEMO / 'sfx-rain.wav'), '-t', str(TOTAL), '-af', 'volume=0.34,afade=t=in:st=0:d=1.5,afade=t=out:st=' + str(TOTAL - 2) + ':d=2', '-ar', '48000', '-ac', '2', str(rain)])
audio_inputs += ['-i', str(rain)]
mix_labels.append(f'[{index}:a]')
index += 1

for file, start, volume in [('sfx-umbrella.wav', 54.0, 0.36), ('sfx-heartbeat.wav', 78.0, 0.32)]:
    source = DEMO / file
    out = TMP / f'{file}.mix.wav'
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', str(source), '-af', f'volume={volume},adelay={int(start * 1000)}|{int(start * 1000)}', '-t', str(TOTAL), '-ar', '48000', '-ac', '2', str(out)])
    audio_inputs += ['-i', str(out)]
    mix_labels.append(f'[{index}:a]')
    index += 1

for shot, (_, file, offset) in DIALOGUES.items():
    start = STARTS[shot - 1] + offset
    out = TMP / f'{file}.mix.wav'
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', str(DEMO / file), '-af', f'volume=1.45,adelay={int(start * 1000)}|{int(start * 1000)}', '-t', str(TOTAL), '-ar', '48000', '-ac', '2', str(out)])
    audio_inputs += ['-i', str(out)]
    mix_labels.append(f'[{index}:a]')
    index += 1

mix = TMP / 'mix.wav'
filter_complex = ''.join(mix_labels) + f'amix=inputs={len(mix_labels)}:duration=longest:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[out]'
run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', *audio_inputs, '-filter_complex', filter_complex, '-map', '[out]', '-t', str(TOTAL), str(mix)])

# 字幕（ASS，随成片烧录）
def ass_time(seconds):
    cs = max(0, round(seconds * 100))
    h = cs // 360000
    m = (cs % 360000) // 6000
    s = (cs % 6000) // 100
    c = cs % 100
    return f'{h}:{m:02d}:{s:02d}.{c:02d}'

ass_lines = [
    '[Script Info]',
    'Title: Morrow Studio Demo',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'PlayResX: 960',
    'PlayResY: 540',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Morrow,Microsoft YaHei,28,&H00EDE7DA,&H000000FF,&H99101418,&H99000000,0,0,0,0,100,100,0.5,0,1,2,1,2,48,48,40,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
]
for shot, (text, _, offset) in DIALOGUES.items():
    start = STARTS[shot - 1] + offset
    end = STARTS[shot - 1] + DURATIONS[shot - 1] - 0.35
    ass_lines.append(f'Dialogue: 0,{ass_time(start)},{ass_time(end)},Morrow,,0,0,40,,{text}')
ass_file = TMP / 'subs.ass'
ass_file.write_text('\n'.join(ass_lines) + '\n', encoding='utf-8')

output = DEMO / 'demo-draft.mp4'
run([
    'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
    '-i', str(video), '-i', str(mix),
    '-vf', 'ass=subs.ass',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-t', str(TOTAL), '-movflags', '+faststart',
    str(output)
], cwd=TMP)

poster = DEMO / 'demo-draft-poster.jpg'
run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-ss', '49', '-i', str(output), '-frames:v', '1', '-q:v', '3', str(poster)])
print('done', output, output.stat().st_size, 'bytes', 'duration', TOTAL)
