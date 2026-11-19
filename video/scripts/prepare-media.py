"""Build Chinese narration, timed Caption JSON/SRT and an original music bed."""

import asyncio
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import wave

import edge_tts
import imageio_ffmpeg
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'public'
AUDIO = PUBLIC / 'audio'
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
STORY = json.loads((ROOT / 'storyboard.json').read_text(encoding='utf-8'))
SAMPLE_RATE = 48000
VOICE = 'zh-CN-XiaoxiaoNeural'
AUDIO.mkdir(parents=True, exist_ok=True)
(PUBLIC / 'images').mkdir(exist_ok=True)
for name in ['workspace.webp', 'files.webp', 'models.webp', 'social.png']:
    shutil.copyfile(ROOT.parent / 'website' / 'public' / 'images' / name, PUBLIC / 'images' / name)


def ffmpeg(*args):
    subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', *map(str, args)], check=True)


def srt_time(ms):
    ms = round(ms)
    return f'{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}'


async def narrate(scene, semaphore):
    async with semaphore:
        text = ''.join(scene['lines'])
        fingerprint = hashlib.sha256((VOICE + '|-3%|' + text).encode()).hexdigest()
        mp3 = AUDIO / (scene['id'] + '.mp3')
        metadata = AUDIO / (scene['id'] + '.timings.json')
        if not mp3.exists() or not metadata.exists() or json.loads(metadata.read_text()).get('fingerprint') != fingerprint:
            for attempt in range(3):
                try:
                    events = []
                    with mp3.open('wb') as stream:
                        communicator = edge_tts.Communicate(text, VOICE, rate='-3%', boundary='WordBoundary', receive_timeout=45)
                        async for chunk in communicator.stream():
                            if chunk['type'] == 'audio':
                                stream.write(chunk['data'])
                            elif chunk['type'] == 'WordBoundary':
                                events.append({key: chunk[key] for key in ['offset', 'duration', 'text']})
                    if not events or mp3.stat().st_size < 1000:
                        raise RuntimeError('Narration returned no audio or timings')
                    metadata.write_text(json.dumps({'fingerprint': fingerprint, 'events': events}, ensure_ascii=False), encoding='utf-8')
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    await asyncio.sleep(2 + attempt)
        events = json.loads(metadata.read_text(encoding='utf-8'))['events']
        raw = AUDIO / (scene['id'] + '.raw.wav')
        ffmpeg('-i', mp3, '-ac', '1', '-ar', SAMPLE_RATE, raw)
        with wave.open(str(raw)) as wav:
            natural_duration = wav.getnframes() / wav.getframerate()
        lead = 0.85
        available = scene['seconds'] - lead - 0.9
        speed = max(1, natural_duration / available)
        if speed > 1.38:
            raise RuntimeError(f"Narration too long for {scene['id']}: {natural_duration:.2f}s")
        padded = AUDIO / (scene['id'] + '.wav')
        ffmpeg('-i', raw, '-af', f'atempo={speed:.7f},loudnorm=I=-17:TP=-2:LRA=9,adelay={int(lead*1000)}:all=1,apad', '-t', scene['seconds'], '-ac', '1', '-ar', SAMPLE_RATE, padded)
        cursor = 0
        words = []
        for event in events:
            location = text.find(event['text'], cursor)
            if location < 0:
                location = cursor
            words.append({'start': location, 'end': location + len(event['text']), 'startMs': event['offset'] / 10000 / speed + lead * 1000, 'endMs': (event['offset'] + event['duration']) / 10000 / speed + lead * 1000})
            cursor = location + len(event['text'])
        captions = []
        cursor = 0
        for line in scene['lines']:
            # Split long narration into comfortably readable caption phrases.
            pieces = re.findall(r'[^，；。！？]+[，；。！？]?', line)
            chunks = []
            current = ''
            for piece in pieces:
                if len(current + piece) > 27 and current:
                    chunks.append(current)
                    current = piece
                else:
                    current += piece
            if current:
                chunks.append(current)
            for chunk in chunks:
                location = text.find(chunk, cursor)
                matched = [word for word in words if word['end'] > location and word['start'] < location + len(chunk)]
                if not matched:
                    raise RuntimeError('Could not align caption: ' + chunk)
                start = matched[0]['startMs']
                end = min(scene['seconds'] * 1000 - 450, matched[-1]['endMs'] + 150)
                captions.append({'text': chunk, 'startMs': round(start), 'endMs': round(end), 'timestampMs': round(start), 'confidence': None})
                cursor = location + len(chunk)
        print(f"{scene['id']}: natural={natural_duration:.2f}s, speed={speed:.3f}, slot={scene['seconds']}s", flush=True)
        return captions


def original_music(total_seconds):
    count = int(total_seconds * SAMPLE_RATE)
    music = np.zeros((count, 2), dtype=np.float32)
    rng = np.random.default_rng(4372)
    beat = 60 / 84
    chords = [(45, 52, 57, 60, 64), (41, 48, 53, 57, 60), (48, 55, 60, 64, 67), (43, 50, 55, 59, 62)]

    def add(start, tone, pan=0):
        begin = int(start * SAMPLE_RATE)
        usable = min(len(tone), count - begin)
        if usable <= 0:
            return
        music[begin:begin + usable, 0] += tone[:usable] * np.sqrt((1 - pan) / 2)
        music[begin:begin + usable, 1] += tone[:usable] * np.sqrt((1 + pan) / 2)

    def frequency(note):
        return 440 * 2 ** ((note - 69) / 12)

    for bar in range(int(total_seconds / (beat * 4)) + 1):
        start = bar * beat * 4
        chord = chords[(bar // 2) % len(chords)]
        duration = beat * 4.6
        t = np.arange(int(duration * SAMPLE_RATE), dtype=np.float32) / SAMPLE_RATE
        envelope = np.minimum(t / .6, 1) * np.minimum((duration - t) / 1.1, 1)
        for index, note in enumerate(chord[1:]):
            f = frequency(note)
            pad = (np.sin(2*np.pi*f*t) + .18*np.sin(2*np.pi*f*2*t + .4)) * envelope * .035
            add(start, pad, (index - 1.5) * .28)
        for step in range(8):
            length = beat * 1.8
            x = np.arange(int(length * SAMPLE_RATE), dtype=np.float32) / SAMPLE_RATE
            note = chord[[2, 3, 4, 3, 1, 3, 4, 2][step]] + 12
            f = frequency(note)
            pluck = (np.sin(2*np.pi*f*x) + .15*np.sin(4*np.pi*f*x)) * np.exp(-x*5) * np.minimum(x/.012, 1) * .027
            add(start + step * beat / 2, pluck, -.45 if step % 2 else .45)
        for step in [0, 2]:
            x = np.arange(int(.25*SAMPLE_RATE), dtype=np.float32) / SAMPLE_RATE
            kick = np.sin(2*np.pi*(47*x+5*(1-np.exp(-x*20)))) * np.exp(-x*19) * .065
            add(start + step*beat, kick)
        for step in range(4):
            x = np.arange(int(.06*SAMPLE_RATE), dtype=np.float32) / SAMPLE_RATE
            noise = rng.standard_normal(len(x)).astype(np.float32)
            noise = np.concatenate(([0], np.diff(noise))) * np.exp(-x*80) * .0025
            add(start + (step+.5)*beat, noise, .2)
    fade = np.minimum(np.arange(count) / (SAMPLE_RATE*3), 1) * np.minimum((count-np.arange(count))/(SAMPLE_RATE*4), 1)
    music *= fade[:, None]
    return music


async def main():
    assert sum(scene['seconds'] for scene in STORY) == 180
    semaphore = asyncio.Semaphore(3)
    results = await asyncio.gather(*(narrate(scene, semaphore) for scene in STORY))
    all_captions = []
    cursor = 0
    narration = []
    for scene, captions in zip(STORY, results):
        for caption in captions:
            all_captions.append({**caption, 'startMs': caption['startMs'] + cursor*1000, 'endMs': caption['endMs'] + cursor*1000, 'timestampMs': caption['timestampMs'] + cursor*1000})
        scene['start'] = cursor
        cursor += scene['seconds']
        narration.append(f"{scene['start']:03d}–{cursor:03d}s | {scene['title']}\n" + '\n'.join(scene['lines']))
    (PUBLIC / 'captions.json').write_text(json.dumps(all_captions, ensure_ascii=False, indent=2), encoding='utf-8')
    (ROOT / 'src' / 'captions.json').write_text(json.dumps(all_captions, ensure_ascii=False, indent=2), encoding='utf-8')
    (ROOT / 'src' / 'timeline.json').write_text(json.dumps(STORY, ensure_ascii=False, indent=2), encoding='utf-8')
    output = ROOT.parent / 'output' / 'sshstar-video'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'sshStar-产品介绍.srt').write_text('\n\n'.join(f"{i+1}\n{srt_time(c['startMs'])} --> {srt_time(c['endMs'])}\n{c['text']}" for i,c in enumerate(all_captions)) + '\n', encoding='utf-8-sig')
    (output / '旁白与分镜.txt').write_text('\n\n'.join(narration), encoding='utf-8-sig')
    voice = np.zeros((180*SAMPLE_RATE,), dtype=np.float32)
    offset = 0
    for scene in STORY:
        with wave.open(str(AUDIO / (scene['id'] + '.wav'))) as wav:
            samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768
        length = min(len(samples), int(scene['seconds'] * SAMPLE_RATE))
        voice[offset:offset+length] = samples[:length]
        offset += scene['seconds'] * SAMPLE_RATE
    music = original_music(180)
    # Duck the original music below narration, retaining it in the chapter pauses.
    envelope = np.convolve((np.abs(voice[::480]) > .015).astype(float), np.ones(30)/30, mode='same')
    duck = np.repeat(1-.66*np.clip(envelope*2, 0, 1), 480)[:len(voice)]
    stereo = voice[:,None]*.92 + music * duck[:,None]*.55
    stereo = np.clip(stereo, -.98, .98)
    master = AUDIO / 'master.wav'
    with wave.open(str(master), 'wb') as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes((stereo*32767).astype('<i2').tobytes())
    ffmpeg('-i', master, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=9,afade=t=in:d=1.2,afade=t=out:st=177:d=3', '-c:a', 'aac', '-b:a', '256k', '-ar', SAMPLE_RATE, AUDIO / 'soundtrack.m4a')
    print(f'Prepared {len(all_captions)} captions and exactly 180 seconds of original soundtrack.', flush=True)


if __name__ == '__main__':
    asyncio.run(main())
