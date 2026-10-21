# M4A Splitter

Record → Split → Transcribe. Split recordings into parts on your own device, then transcribe them with Groq Whisper.

Live: https://gitgt1.github.io/m4a-splitter/ · Recommended: Chrome on Android, Chrome or Edge on PC.

**Quick start:** drop a recording → paste your Groq key in step 3 (tick Remember) → tap **Split & transcribe**.

## Use on PC
Double-click `index.html` (Chrome or Edge). Everything works except install and offline mode, which need the hosted version.

## Use on Android
Open the hosted link in Chrome and tap **Install** (or ⋮ → **Add to Home screen**). Firefox on Android can add it to the home screen too, but cannot receive recordings via Share. Firefox on PC cannot install web apps; the page still works in a tab. After installing:
- It opens like an app and works offline (except transcription).
- In your recorder app: **Share → Splitter** loads the recording directly.
- **Share all** / **Share** sends parts or the transcript to Drive, WhatsApp, Gmail or Claude.

## Split
- **Minutes / Seconds / MB** per part.
- **Quick split**: exact times.
- **Smart split**: each cut moves to the nearest pause (within 10% of the part length, max 15 s). Tagged `pause`, or `quiet` when no real pause was near.
- **Split & transcribe** (one tap): about 10 min per part, max ~20 MB, cut on pauses, then transcription starts if a key is saved.
- **Split only** (custom length) holds Quick/Smart split and the length setting.
- M4A (AAC) is copied frame by frame: no re-encoding, no quality loss, cuts accurate to ~23 ms.
- MP3, WAV, OGG and FLAC are decoded and written as M4A where the browser can encode AAC (Chrome/Edge on Windows, Android), otherwise WAV.
- Extras: ZIP of everything, chapter marks (.txt, CUE, JSON), loudness per part in LUFS.

## Transcribe
1. Get a key at https://console.groq.com/keys and paste it in step 3 (or tap **⚙ Key** at the top). Tick "Remember" to store it on this device only; Change/Forget appear once saved.
2. Pick model and language (or auto). Add names/terms so Whisper spells them right.
3. **Transcribe parts**. Two parts run at a time, rate limits retry automatically, a failed part can be retried alone.
4. The transcript merges all parts with timestamps matching the original recording. Copy, share, or download .txt / .srt / .vtt / .json.

Cost: turbo about $0.04 per hour of audio, large-v3 about $0.11. Only this step sends audio out, part by part, to Groq. Any OpenAI-compatible endpoint can be set under Advanced.

## Complete transcripts
- The transcript box grows with the text, so nothing hides inside it. A line shows "x of y parts · text ends at mm:ss of mm:ss · words".
- Parts without text appear inline (`[Part 6 · 50:00–58:12 · not transcribed yet]`) with **Transcribe missing parts**.
- After each part the app checks for a missing end (> 15 s) or gaps (> 30 s with sound) and re-sends just that stretch once.
- Your own edits are never overwritten: new text shows an **Update** prompt.
- If parts come back in different languages, a hint suggests picking the language.

## Library
- Every split is saved automatically. **Library** tab: rename, search titles and transcripts, open again, copy/share/download the transcript, audio ZIP, delete audio, delete.
- **New recording** clears the page; nothing is lost.
- Audio is removed after 30 days, transcripts are kept.

## Long jobs, screen off, refresh
- A progress bar with % and time left stays pinned at the bottom, with **Cancel**.
- Reloading or closing while working asks "Leave site?". Pull-to-refresh is disabled.
- The screen is kept on while working. If you lock the phone or switch apps, Android pauses the page; it continues when you come back.
- Finished parts and transcripts are saved on the device. If Android closes the page, reopen the app: it restores them, and **Transcribe parts** only sends what is still missing.

## Browsers
Chrome, Edge, Safari: full support. Firefox (incl. Android) uses a slower chunked decoder for pause finding, with progress. Browsers that cannot decode AAC at all (open-source Chromium on Linux) still split losslessly, but Smart split falls back to exact cuts.

## Files
`index.html` UI · `app.js` logic · `m4a.js` lossless demux/mux · `analysis.js` pauses + LUFS · `transcribe.js` Groq client · `library.js` Library + save/resume · `subtitles.js` exports · `sw.js` + `manifest.json` install/offline/share · `vendor/` mp4box 0.5.2, mp4-muxer 5.1.3, JSZip 3.10.1
