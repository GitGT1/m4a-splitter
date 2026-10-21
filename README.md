# M4A Splitter

Split recordings into parts on your own device, then transcribe them with Groq Whisper.

## Use on PC
Double-click `index.html` (Chrome or Edge). Everything works except install and offline mode, which need the hosted version.

## Use on Android
Open the hosted link in Chrome, tap ⋮ → **Add to Home screen**. After that:
- It opens like an app and works offline (except transcription).
- In your recorder app: **Share → Splitter** loads the recording directly.
- **Share all** / **Share** sends parts or the transcript to Drive, WhatsApp, Gmail or Claude.

## Split
- **Minutes / Seconds / MB** per part.
- **Quick split**: exact times.
- **Smart split**: each cut moves to the nearest pause (within 10% of the part length, max 15 s). Tagged `pause`, or `quiet` when no real pause was near.
- **Preset for transcription**: about 10 min per part, max ~20 MB, cut on pauses.
- M4A (AAC) is copied frame by frame: no re-encoding, no quality loss, cuts accurate to ~23 ms.
- MP3, WAV, OGG and FLAC are decoded and written as M4A where the browser can encode AAC (Chrome/Edge on Windows, Android), otherwise WAV.
- Extras: ZIP of everything, chapter marks (.txt, CUE, JSON), loudness per part in LUFS.

## Transcribe
1. Get a key at https://console.groq.com/keys and paste it. Tick "Remember" to store it on this device only.
2. Pick model and language (or auto). Add names/terms so Whisper spells them right.
3. **Transcribe parts**. Two parts run at a time, rate limits retry automatically, a failed part can be retried alone.
4. The transcript merges all parts with timestamps matching the original recording. Copy, share, or download .txt / .srt / .vtt / .json.

Cost: turbo about $0.04 per hour of audio, large-v3 about $0.11. Only this step sends audio out, part by part, to Groq. Any OpenAI-compatible endpoint can be set under Advanced.

## Browsers
Chrome, Edge, Safari: full support. Browsers without an AAC decoder (some Linux builds, open-source Chromium) still split losslessly, but Smart split falls back to exact cuts and loudness is unavailable.

## Files
`index.html` UI · `app.js` logic · `m4a.js` lossless demux/mux · `analysis.js` pauses + LUFS · `transcribe.js` Groq client · `subtitles.js` exports · `sw.js` + `manifest.json` install/offline/share · `vendor/` mp4box 0.5.2, mp4-muxer 5.1.3, JSZip 3.10.1
