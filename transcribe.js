/* Groq Whisper client: per-part upload, retry on rate limits, timestamp merge. */
(function () {
  'use strict';

  const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
  const MAX_BYTES = 24 * 1024 * 1024; // Groq free tier caps uploads at 25 MB
  const PRICE_PER_HOUR = { 'whisper-large-v3-turbo': 0.04, 'whisper-large-v3': 0.111 };

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal && signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });

  // Groq bills at least 10 s per request.
  function estimateCost(durations, model) {
    const sec = durations.reduce((a, d) => a + Math.max(10, d), 0);
    return (sec / 3600) * (PRICE_PER_HOUR[model] || 0.04);
  }

  // Parse "Please try again in 1m2.5s" / "in 750ms" from a 429 body.
  function waitFromMessage(msg) {
    const m = /try again in ((\d+)h)?((\d+)m(?!s))?(([\d.]+)s)?((\d+)ms)?/i.exec(msg || '');
    if (!m) return 0;
    return ((+m[2] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[6] || 0)) * 1000 + (+m[8] || 0);
  }

  // Shrink a part that is over the upload limit: decode and resample to 16 kHz mono WAV.
  async function shrink(blob) {
    const buf = await M4A.decodeWhole(await blob.arrayBuffer());
    const sr = 16000, len = Math.ceil(buf.duration * sr);
    const off = new OfflineAudioContext(1, len, sr);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    return M4A.wavBlob(out, 0, out.length);
  }

  async function requestOnce(blob, name, opt, signal) {
    const fd = new FormData();
    fd.append('file', blob, name);
    fd.append('model', opt.model);
    fd.append('response_format', 'verbose_json');
    fd.append('temperature', '0');
    fd.append('timestamp_granularities[]', 'segment');
    if (opt.language) fd.append('language', opt.language);
    if (opt.prompt) fd.append('prompt', opt.prompt.slice(0, 800));
    const res = await fetch(opt.endpoint || GROQ_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + opt.apiKey },
      body: fd,
      signal,
    });
    let body = null;
    try { body = await res.json(); } catch (e) { /* non-JSON error page */ }
    if (res.ok) return body;
    const msg = (body && body.error && (body.error.message || body.error)) || res.statusText || 'HTTP ' + res.status;
    const err = new Error(String(msg));
    err.status = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    const ra = res.headers.get('retry-after');
    err.wait = ra ? parseFloat(ra) * 1000 : waitFromMessage(String(msg));
    throw err;
  }

  // Transcribe one part. Returns segments with times relative to the part.
  async function transcribePart(part, opt, signal, onStatus) {
    let blob = part.blob, name = part.name;
    if (blob.size > MAX_BYTES) {
      onStatus && onStatus('Shrinking for upload');
      blob = await shrink(blob);
      name = name.replace(/\.\w+$/, '') + '_16k.wav';
      if (blob.size > MAX_BYTES) throw new Error('Part is too long for one request. Split into shorter parts (max ~12 min).');
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await requestOnce(blob, name, opt, signal);
        const segs = (r.segments && r.segments.length)
          ? r.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }))
          : [{ start: 0, end: part.end - part.start, text: r.text || '' }];
        return { text: r.text || '', segments: segs, language: r.language };
      } catch (e) {
        if (e.name === 'AbortError' || !e.retryable || attempt >= 5) throw e;
        const wait = Math.min(120000, e.wait || 2000 * Math.pow(2, attempt));
        onStatus && onStatus(`Rate limited, retrying in ${Math.ceil(wait / 1000)} s`);
        await sleep(wait, signal);
        onStatus && onStatus('Transcribing');
      }
    }
  }

  // Stretches of a part with no text: a missing tail (> 15 s) or gaps (> 30 s).
  // hasSound(t0, t1) can veto gaps that are real silence; times are part-relative.
  function findGaps(transcript, partDur, hasSound) {
    const segs = (transcript.segments || []).filter((x) => x.text && x.text.trim()).sort((a, b) => a.start - b.start);
    const gaps = [];
    if (!segs.length) {
      if (partDur > 15) gaps.push([0, partDur]);
    } else {
      if (segs[0].start > 30) gaps.push([0, segs[0].start]);
      for (let i = 1; i < segs.length; i++) if (segs[i].start - segs[i - 1].end > 30) gaps.push([segs[i - 1].end, segs[i].start]);
      const last = segs[segs.length - 1].end;
      if (partDur - last > 15) gaps.push([last, partDur]);
    }
    return gaps.filter(([a, b]) => !hasSound || hasSound(a, b));
  }

  // Cut [a, b] seconds out of a part's audio (lossless for M4A, WAV otherwise).
  async function clip(blob, a, b) {
    const ab = await blob.arrayBuffer();
    try {
      const d = await M4A.demux(ab);
      return { blob: M4A.muxFrames(d, M4A.frameAt(d, a), Math.max(M4A.frameAt(d, a) + 1, M4A.frameAt(d, b))), ext: 'm4a' };
    } catch (e) {
      const buf = await M4A.decodeWhole(ab);
      const sr = buf.sampleRate;
      return { blob: M4A.wavBlob(buf, Math.floor(a * sr), Math.min(buf.length, Math.ceil(b * sr))), ext: 'wav' };
    }
  }

  // Re-transcribe each gap once (with 2 s of lead-in) and merge the new text in.
  // Returns the number of gaps that produced text.
  async function fillGaps(part, opt, signal, hasSound, onStatus) {
    const dur = part.end - part.start;
    const gaps = findGaps(part.transcript, dur, hasSound);
    let filled = 0;
    for (let g = 0; g < gaps.length; g++) {
      const [ga, gb] = gaps[g];
      const a = Math.max(0, ga - 2), b = Math.min(dur, gb + 0.5);
      onStatus && onStatus(`Checking missing text ${g + 1}/${gaps.length}`);
      const c = await clip(part.blob, a, b);
      const sub = { blob: c.blob, name: part.name.replace(/\.\w+$/, '') + `_gap${g + 1}.${c.ext}`, start: 0, end: b - a };
      const r = await transcribePart(sub, opt, signal);
      // Keep only text that falls inside the gap (drops the overlapped lead-in).
      const fresh = r.segments
        .map((x) => ({ start: x.start + a, end: x.end + a, text: x.text }))
        .filter((x) => x.text.trim() && (x.start + x.end) / 2 >= ga - 0.25 && x.start <= gb + 0.25);
      if (fresh.length) {
        part.transcript.segments = part.transcript.segments.concat(fresh).sort((p, q) => p.start - q.start);
        filled++;
      }
    }
    part.transcript.checked = true;
    part.transcript.filled = (part.transcript.filled || 0) + filled;
    return filled;
  }

  // Run jobs with a fixed number in flight.
  async function runQueue(jobs, concurrency, worker) {
    let next = 0;
    const lanes = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const j = jobs[next++];
        await worker(j);
      }
    });
    await Promise.all(lanes);
  }

  // Merge per-part results into one timeline, shifted by each part's start.
  function merge(parts) {
    const out = [];
    for (const p of parts) {
      if (!p.transcript) continue;
      for (const s of p.transcript.segments) out.push({ start: s.start + p.start, end: s.end + p.start, text: s.text, part: p.index });
    }
    return out;
  }

  window.Transcribe = { GROQ_URL, MAX_BYTES, PRICE_PER_HOUR, estimateCost, transcribePart, runQueue, merge, findGaps, fillGaps };
})();
