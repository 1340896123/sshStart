# sshStar 三分钟产品介绍

Remotion 4 项目，1920 × 1080，30 fps，5400 帧，成片严格 180 秒。包含中文合成旁白、烧录字幕、独立 SRT 字幕、原创轻电子背景音乐与官网二维码。

## 预览与导出

```powershell
cd video
npm ci
python -m pip install imageio-ffmpeg
npm run dev
```

在 http://localhost:3005/sshStar-Product-Intro 预览。每个分镜位于独立的 `src/scenes/` 文件，可在 Studio 时间轴中定位。

```powershell
npm run lint
npm run review
npm run render
```

成片输出到仓库根目录 `output/sshstar-video/sshStar-产品介绍-3分钟.mp4`。Remotion 完成后，导出脚本会调用 Python/imageio-ffmpeg 统一为 Rec.709、有限颜色范围的 yuv420p，并写入 fast-start MP4，配合 H.264、AAC 音频以兼容常用播放器。原始渲染母版保存在 `output/sshstar-video/review/`。Windows 自动使用本机 Microsoft Edge；其他环境使用 Remotion Chromium。画面字体优先使用系统 Microsoft YaHei，请在跨平台渲染时提供兼容的中文字体。

## 内容与素材

- `storyboard.json`：10 个分镜、固定时长和完整中文旁白。
- `src/timeline.json`：包含起始秒数的分镜时间轴。
- `src/captions.json`：符合 Remotion Caption 类型、按合成语音边界对齐的字幕。
- `public/audio/soundtrack.m4a`：旁白与原创音乐混音。
- `public/images/`：实际产品界面、官网截图与 QR 码。界面预览采用示例服务器 `192.0.2.10`；其他图形标记为工作流示意。

00:00 品牌开场；00:12 多窗口切换；00:28 一体工作台；00:46 连接与独立会话；01:06 SFTP 与编辑；01:28 AI 助手；01:52 模型配置；02:10 安全边界；02:28 可选加密同步；02:44 官网与下载。

## 重建旁白、字幕与音乐

```powershell
python -m pip install edge-tts imageio-ffmpeg numpy pillow playwright qrcode
python scripts/prepare-media.py
python scripts/capture-website.py
```

旁白采用 `zh-CN-XiaoxiaoNeural`。按语音边界生成字幕，必要时轻微调整速度，使每段落在固定分镜中。背景音乐由脚本确定性合成，不使用外部曲库。缓存的临时 WAV、原始 MP3 和边界文件不进入 Git；当前成片需要的混音已保存在 public 中。

`npm run review` 输出 10 个分镜关键帧；导出完成后还应核对最终 MP4 的时长、尺寸、音轨、字幕和官网二维码。

运行 `python scripts/verify-output.py` 可以核对成片参数、解码全片、检测音量并提取最终成片的封面及关键画面。

Remotion 使用条款参见 [Remotion License](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)。
