"""Verify the rendered MP4, decode every frame, and export actual video stills."""

import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

from PIL import Image
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT.parent / 'output' / 'sshstar-video'
VIDEO = OUTPUT / 'sshStar-产品介绍-3分钟.mp4'
BIN = ROOT / 'node_modules' / '@remotion' / 'compositor-win32-x64-msvc'
FFPROBE = shutil.which('ffprobe') or str(BIN / 'ffprobe.exe')
FFMPEG = shutil.which('ffmpeg') or imageio_ffmpeg.get_ffmpeg_exe()

metadata = json.loads(subprocess.check_output([FFPROBE, '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(VIDEO)]))
video = next(stream for stream in metadata['streams'] if stream['codec_type'] == 'video')
audio = next(stream for stream in metadata['streams'] if stream['codec_type'] == 'audio')
assert video['width'] == 1920 and video['height'] == 1080
assert video['codec_name'] == 'h264' and video['pix_fmt'] == 'yuv420p'
assert video['avg_frame_rate'] == '30/1'
assert int(video['nb_frames']) == 5400
assert abs(float(metadata['format']['duration']) - 180) < .05
assert audio['codec_name'] == 'aac' and audio['channels'] == 2
subprocess.run([FFMPEG, '-hide_banner', '-v', 'error', '-i', str(VIDEO), '-f', 'null', '-'], check=True)
volume = subprocess.run([FFMPEG, '-hide_banner', '-i', str(VIDEO), '-vn', '-af', 'volumedetect', '-f', 'null', '-'], capture_output=True, text=True, check=True).stderr
mean = re.search(r'mean_volume: ([\d.-]+) dB', volume)
peak = re.search(r'max_volume: ([\d.-]+) dB', volume)
for seconds, name in [(6, 'sshStar-封面.png'), (77, '成片-远程文件.png'), (172, '成片-官网与下载.png')]:
    subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(seconds), '-i', str(VIDEO), '-frames:v', '1', str(OUTPUT / name)], check=True)
digest = hashlib.sha256(VIDEO.read_bytes()).hexdigest()
(OUTPUT / 'SHA256SUMS.txt').write_text(f'{digest}  {VIDEO.name}\n', encoding='utf-8')
result = {'duration': float(metadata['format']['duration']), 'width': video['width'], 'height': video['height'], 'fps': video['avg_frame_rate'], 'frames': int(video['nb_frames']), 'videoCodec': video['codec_name'], 'audioCodec': audio['codec_name'], 'audioChannels': audio['channels'], 'meanVolumeDb': float(mean.group(1)) if mean else None, 'peakVolumeDb': float(peak.group(1)) if peak else None, 'bytes': VIDEO.stat().st_size, 'sha256': digest, 'fullDecode': 'passed'}
(OUTPUT / '成片验证.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
