"""Normalize the rendered master to a standard Rec.709 H.264 delivery MP4."""

from pathlib import Path
import subprocess
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT.parent / 'output' / 'sshstar-video'
MASTER = OUTPUT / 'review' / 'render-master.mp4'
VIDEO = OUTPUT / 'sshStar-产品介绍-3分钟.mp4'
if not MASTER.exists():
    if not VIDEO.exists():
        raise RuntimeError('Render the Remotion composition first')
    VIDEO.replace(MASTER)
command = [imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-y', '-i', str(MASTER), '-i', str(ROOT / 'public/audio/soundtrack.m4a'), '-map', '0:v:0', '-map', '1:a:0', '-vf', 'scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p', '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-threads', '8', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'copy', '-t', '180', '-movflags', '+faststart', '-metadata', 'title=sshStar 产品介绍', '-metadata', 'comment=Created with Remotion; Chinese narration and original music', '-progress', 'pipe:1', '-nostats', str(VIDEO)]
process = subprocess.Popen(command, stdout=subprocess.PIPE, text=True, encoding='utf-8', errors='replace')
previous = -1
for line in process.stdout:
    if line.startswith('out_time_us='):
        progress = int(line.split('=')[1]) / 1000000 / 180
        bucket = int(progress * 4)
        if bucket != previous:
            previous = bucket
            print(f'Delivery encoding: {progress*100:.0f}%', flush=True)
if process.wait() != 0:
    raise RuntimeError('Delivery encoding failed')
print('Standard Rec.709 / yuv420p / fast-start MP4 ready.', flush=True)
