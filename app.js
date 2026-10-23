/* UI and split orchestration. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const S = window.Subs;
  const state = { unit: 'min', files: [], busy: false, abort: null, current: null };
  let nextId = 1;

  const fmtSize = (b) => (b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const baseName = (n) => n.replace(/\.[^.]+$/, '');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  // ---------- busy state, progress, wake lock ----------
  let wakeLock = null;
  async function setBusy(on, text) {
    state.busy = on;
    $('progress').classList.toggle('hidden', !on);
    document.body.classList.toggle('busy', on);
    if (on) {
      state.abort = new AbortController();
      state.jobStart = Date.now();
      progress(0, text || 'Working');
    }
    updateButtons();
    try {
      if (on && navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { /* wake lock is a nice-to-have */ }
  }
  function progress(frac, text) {
    frac = Math.max(0, Math.min(1, frac));
    $('barFill').style.width = Math.round(frac * 100) + '%';
    if (text) $('progressText').textContent = text;
    // Rough time left once there is enough signal.
    const el = (Date.now() - (state.jobStart || Date.now())) / 1000;
    let eta = '';
    if (frac > 0.03 && frac < 1 && el > 2) {
      const left = (el * (1 - frac)) / frac;
      eta = left < 60 ? ` · ~${Math.ceil(left)} s left` : ` · ~${Math.ceil(left / 60)} min left`;
    }
    $('progressPct').textContent = Math.round(frac * 100) + '%' + eta;
  }
  const aborted = () => state.abort && state.abort.signal.aborted;
  const isAbort = (e) => e && e.name === 'AbortError';

  // Warn before reload / closing while work is running.
  window.addEventListener('beforeunload', (e) => {
    if (!state.busy) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // Screen off / app switch: the browser pauses the page. Tell the user when they are back.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (!state.busy) return;
    if (hiddenAt && Date.now() - hiddenAt > 3000) toast('Welcome back. Continuing where it paused.');
    if (navigator.wakeLock && !wakeLock) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* ignore */ }
    }
  });

  // ---------- loading files ----------
  async function addFiles(list) {
    for (const file of list) {
      const f = { id: nextId++, file, name: file.name, status: 'Reading', parts: null };
      state.files.push(f);
      renderFiles();
      try {
        const buf = await file.arrayBuffer();
        try {
          f.demux = await M4A.demux(buf);
          f.mode = 'copy';
          const m = f.demux.meta;
          f.duration = m.duration;
          f.info = `${S.clock(m.duration)} · ${fmtSize(file.size)} · ${Math.round(m.bitrate / 1000)} kbps · ${m.sampleRate / 1000} kHz · ${m.channels === 1 ? 'mono' : m.channels === 2 ? 'stereo' : m.channels + ' ch'}`;
          f.status = 'Lossless';
        } catch (e) {
          // Not AAC-in-MP4: decode to PCM and re-encode the parts.
          f.pcm = await M4A.decodeWhole(buf);
          f.mode = 'pcm';
          f.duration = f.pcm.duration;
          f.aac = await M4A.canEncodeAac(f.pcm.sampleRate, f.pcm.numberOfChannels);
          f.info = `${S.clock(f.duration)} · ${fmtSize(file.size)} · ${f.pcm.sampleRate / 1000} kHz · ${f.pcm.numberOfChannels} ch`;
          f.status = f.aac ? 'Re-encoded to M4A' : 'Output as WAV';
        }
      } catch (e) {
        // The picker no longer filters by type, so anything can land here.
        f.error = /^(audio|video)\//.test(file.type) || /\.(m4a|mp4|aac|mp3|wav|ogg|opus|flac|3gp|amr)$/i.test(file.name)
          ? 'This browser cannot read this audio file. Try exporting it as M4A or MP3.'
          : "This isn't an audio file. Pick a recording (M4A, MP3, WAV…).";
        f.status = 'Error';
      }
      renderFiles();
    }
  }

  function renderFiles() {
    const ul = $('fileList');
    ul.innerHTML = state.files.map((f) => `
      <li>
        <div class="grow">
          <div class="name">${esc(f.name)}</div>
          <div class="info">${f.error ? `<span class="err">${esc(f.error)}</span>` : esc(f.info || 'Reading…')}
            ${f.status && !f.error && f.info ? `<span class="tag ${f.mode === 'copy' && !f.restored ? 'ok' : ''}">${esc(f.status)}</span>` : ''}</div>
        </div>
        <button class="btn icon" type="button" data-remove="${f.id}" aria-label="Remove ${esc(f.name)}" ${state.busy ? 'disabled' : ''}>✕</button>
      </li>`).join('');
    updateButtons();
  }

  // Files that can be (re)split. Restored sessions only have their parts, not the original.
  function readyFiles() { return state.files.filter((f) => !f.error && f.duration && !f.restored); }

  function updateButtons() {
    const ok = readyFiles().length > 0 && !state.busy;
    const hasParts = state.files.some((f) => f.parts && f.parts.length);
    $('pipeBtn').disabled = !ok;
    $('quickBtn').disabled = !ok;
    $('smartBtn').disabled = !ok;
    document.querySelectorAll('[data-remove]').forEach((b) => (b.disabled = state.busy));
    $('transcribeBtn').disabled = state.busy || !hasParts;
    $('transcribeBtn').textContent = hasParts ? 'Transcribe parts' : 'Split a recording first';
    const done = { 1: readyFiles().length > 0, 2: hasParts, 3: state.files.some((f) => f.transcript && f.transcript.length) };
    document.querySelectorAll('#steps [data-step]').forEach((li) => li.classList.toggle('done', !!done[li.dataset.step]));
    $('zipBtn').disabled = state.busy;
    $('resetBtn').disabled = state.busy;
  }

  // ---------- analysis (loudness envelope) ----------
  async function analyze(f, label) {
    if (f.analysis) return f.analysis;
    if (f.mode === 'pcm') {
      progress(0.1, label + ': analysing audio');
      await tick();
      f.analysis = Analysis.analyzeBuffer(f.pcm);
      return f.analysis;
    }
    const signal = state.abort && state.abort.signal;
    const onProg = (p) => progress(p * 0.8, `${label}: finding pauses`);
    let an = new Analysis.Analyzer();
    progress(0, `${label}: finding pauses`);
    if (await M4A.decodeStream(f.demux, (ch, n, sr) => an.push(ch, n, sr), onProg, signal)) {
      f.analysis = an.finish();
      return f.analysis;
    }
    // No working WebCodecs decoder (e.g. Firefox on Android): decode in 20 s chunks instead.
    an = new Analysis.Analyzer();
    try {
      await M4A.decodeChunked(f.demux, (ch, n, sr) => an.push(ch, n, sr), onProg, signal);
      f.analysis = an.finish();
    } catch (e) {
      if (isAbort(e)) throw e;
      console.warn('Chunked decode failed', e);
      f.analysis = null;
    }
    return f.analysis;
  }

  // ---------- cut planning ----------
  // Unit adaptor: frames for the lossless path, samples for PCM.
  function units(f) {
    if (f.mode === 'copy') {
      const d = f.demux, n = d.samples.length;
      return {
        count: n,
        time: (i) => d.starts[i],
        at: (t) => M4A.frameAt(d, t),
        bytes: (a, b) => M4A.frameBytes(d, a, b),
      };
    }
    const sr = f.pcm.sampleRate, ch = f.pcm.numberOfChannels;
    const bps = f.aac ? (ch > 1 ? 160000 : 96000) / 8 : sr * ch * 2;
    return {
      count: f.pcm.length,
      time: (i) => i / sr,
      at: (t) => Math.max(0, Math.min(f.pcm.length, Math.round(t * sr))),
      bytes: (a, b) => 1200 + ((b - a) / sr) * bps,
    };
  }

  // Returns [{from, to, snapped}] in units.
  function planParts(f, unit, value, smart) {
    const u = units(f), D = f.duration, an = f.analysis;
    const cuts = [];
    let cur = 0, guard = 0;
    while (guard++ < 100000) {
      const curT = u.time(cur);
      let targetT, lo, hi;
      if (unit === 'mb') {
        // Largest end unit that keeps the part inside the byte budget.
        const budget = value * 1e6;
        let a = cur + 1, b = u.count;
        if (u.bytes(cur, u.count) <= budget) break;
        while (a < b) {
          const mid = (a + b + 1) >> 1;
          if (u.bytes(cur, mid) <= budget) a = mid; else b = mid - 1;
        }
        targetT = u.time(a);
        const len = targetT - curT, w = Math.min(0.1 * len, 15);
        lo = targetT - w; hi = targetT; // never grow past the budget
      } else {
        const L = unit === 'min' ? value * 60 : value;
        targetT = curT + L;
        if (targetT >= D - 0.5) break;
        const w = Math.min(0.1 * L, 15);
        lo = targetT - w; hi = Math.min(D - 0.5, targetT + w);
      }
      let cutT = targetT, snapped = null;
      if (smart && an) {
        const q = Analysis.quietest(an, targetT, Math.max(curT + 1, lo), hi);
        cutT = q.time;
        snapped = q.isPause ? 'pause' : 'quietest';
      }
      let idx = u.at(cutT);
      if (unit === 'mb' && u.bytes(cur, idx) > value * 1e6) idx--;
      if (idx <= cur) idx = cur + 1;
      if (idx >= u.count) break;
      cuts.push({ idx, snapped });
      cur = idx;
    }
    const parts = [];
    let from = 0;
    for (const c of cuts) { parts.push({ from, to: c.idx, snapped: c.snapped }); from = c.idx; }
    parts.push({ from, to: u.count, snapped: null });
    // Fold a tiny tail (under 2 s) into the previous part.
    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      if (u.time(last.to) - u.time(last.from) < 2) {
        parts.pop();
        parts[parts.length - 1].to = last.to;
        parts[parts.length - 1].snapped = null;
      }
    }
    return parts.map((p) => ({ ...p, start: u.time(p.from), end: u.time(p.to) }));
  }

  // ---------- split ----------
  async function split(smart) {
    const value = parseFloat($('lenInput').value);
    if (!(value > 0)) return toast('Enter a part length');
    const files = readyFiles();
    let ok = false;
    await setBusy(true, 'Starting');
    try {
      for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi];
        const label = files.length > 1 ? `File ${fi + 1}/${files.length}` : 'Splitting';
        if (smart && !(await analyze(f, label))) {
          toast('This browser cannot decode AAC, so cuts are at exact times. Use Chrome, Edge or Safari for Smart split.');
        }
        const plan = planParts(f, state.unit, value, smart);
        const pad = String(plan.length).length < 2 ? 2 : String(plan.length).length;
        const ext = f.mode === 'copy' || f.aac ? 'm4a' : 'wav';
        const out = [];
        for (let i = 0; i < plan.length; i++) {
          if (aborted()) throw new DOMException('Cancelled', 'AbortError');
          const p = plan[i];
          progress((smart ? 0.8 : 0) + ((i + 1) / plan.length) * (smart ? 0.2 : 1), `${label}: writing part ${i + 1} of ${plan.length}`);
          await tick();
          let blob;
          if (f.mode === 'copy') blob = M4A.muxFrames(f.demux, p.from, p.to);
          else if (f.aac) blob = await M4A.aacBlob(f.pcm, p.from, p.to);
          else blob = M4A.wavBlob(f.pcm, p.from, p.to);
          out.push({
            index: i, start: p.start, end: p.end, snapped: p.snapped, blob, size: blob.size,
            name: `${baseName(f.name)}_part${String(i + 1).padStart(pad, '0')}.${ext}`,
            lufs: f.analysis ? Analysis.lufs(f.analysis, p.start, p.end) : undefined,
          });
        }
        revokeParts(f);
        f.parts = out;
        f.transcript = null;
      }
      renderResults();
      $('resultsCard').classList.remove('hidden');
      $('restoredNote').classList.add('hidden');
      updateCost();
      renderStatus();
      $('transcriptBox').classList.add('hidden');
      for (const f of files) { f.editedText = null; persistFile(f); }
      ok = true;
    } catch (e) {
      if (isAbort(e)) toast('Cancelled');
      else { console.error(e); toast('Split failed: ' + (e.message || e)); }
    } finally {
      await setBusy(false);
    }
    return ok;
  }

  // One tap: split for transcription (about 10 min, max ~20 MB, on pauses), then transcribe.
  async function splitAndTranscribe() {
    setUnit('min');
    const kbps = Math.max(...readyFiles().map((f) => (f.mode === 'copy' ? f.demux.meta.bitrate / 1000 : 128)), 128);
    const maxMin = (20e6 * 8) / (kbps * 1000) / 60;
    $('lenInput').value = Math.max(1, Math.min(10, Math.floor(maxMin)));
    saveSettings();
    if (!(await split(true))) return;
    if (transcribeOptions().apiKey || $('endpoint').value.trim()) {
      $('transcribeCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      await transcribe();
    } else {
      showKeyEntry();
      $('transcribeCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('apiKey').focus();
      toast('Split done. Paste your Groq key, then tap Transcribe parts.');
    }
  }

  async function measureLoudness(f) {
    await setBusy(true, 'Measuring loudness');
    try {
      if (f.restored) return toast('Pick the original recording again to measure loudness.');
      if (!(await analyze(f, 'Loudness'))) return toast('This browser cannot decode AAC, so loudness is unavailable.');
      for (const p of f.parts) p.lufs = Analysis.lufs(f.analysis, p.start, p.end);
      renderResults();
    } catch (e) {
      toast(isAbort(e) ? 'Cancelled' : 'Could not measure: ' + (e.message || e));
    } finally {
      await setBusy(false);
    }
  }

  function revokeParts(f) {
    for (const p of f.parts || []) if (p.url) URL.revokeObjectURL(p.url);
  }
  const partUrl = (p) => p.url || (p.url = URL.createObjectURL(p.blob));

  // ---------- results ----------
  const canShareFiles = (files) => {
    try { return !!(navigator.canShare && navigator.canShare({ files })); } catch (e) { return false; }
  };

  function renderResults() {
    const done = state.files.filter((f) => f.parts && f.parts.length);
    $('results').innerHTML = done.map((f) => {
      const hasLufs = f.parts.some((p) => p.lufs !== undefined);
      return `<div class="result">
        <h3>${esc(f.title || f.name)}</h3>
        <div class="muted small">${f.parts.length} parts · ${f.mode === 'copy' ? 'lossless copy' : f.aac ? 're-encoded AAC' : 'WAV'}</div>
        <table class="parts">
          <thead><tr><th>#</th><th>Start – end</th><th class="hide-sm">Length</th><th>Size</th>${hasLufs ? '<th class="hide-sm">LUFS</th>' : ''}<th></th></tr></thead>
          <tbody>${f.parts.map((p) => `<tr>
            <td>${p.index + 1}</td>
            <td>${S.clock(p.start)} – ${S.clock(p.end)}${p.snapped === 'pause' ? '<span class="tag ok">pause</span>' : p.snapped === 'quietest' ? '<span class="tag">quiet</span>' : ''}</td>
            <td class="hide-sm">${S.clock(p.end - p.start)}</td>
            <td>${fmtSize(p.size)}</td>
            ${hasLufs ? `<td class="hide-sm">${p.lufs == null ? '–' : p.lufs.toFixed(1)}</td>` : ''}
            <td class="act">${p.blob ? `
              <button class="btn icon" type="button" data-play="${f.id}:${p.index}" aria-label="Play part ${p.index + 1}">▶</button>
              <button class="btn icon" type="button" data-dl="${f.id}:${p.index}" aria-label="Download part ${p.index + 1}">↓</button>` : '<span class="muted small">audio removed</span>'}
            </td></tr>`).join('')}</tbody>
        </table>
        <div class="actions">
          <button class="btn small" type="button" data-chap="copy" data-file="${f.id}">Copy chapter marks</button>
          <button class="btn small" type="button" data-chap="txt" data-file="${f.id}">Chapters .txt</button>
          <button class="btn small" type="button" data-chap="cue" data-file="${f.id}">CUE sheet</button>
          <button class="btn small" type="button" data-chap="json" data-file="${f.id}">Chapters JSON</button>
          ${hasLufs || f.restored ? '' : `<button class="btn small" type="button" data-lufs="${f.id}">Measure loudness</button>`}
        </div>
      </div>`;
    }).join('');
    const all = done.flatMap((f) => f.parts.filter((p) => p.blob).map((p) => new File([p.blob], p.name, { type: p.blob.type })));
    $('shareAllBtn').classList.toggle('hidden', !canShareFiles(all.slice(0, 1)));
  }

  function findPart(key) {
    const [fid, pi] = key.split(':').map(Number);
    const f = state.files.find((x) => x.id === fid);
    return { f, p: f && f.parts[pi] };
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const textBlob = (s, type) => new Blob([s], { type: (type || 'text/plain') + ';charset=utf-8' });

  async function zipAll() { return zipFiles(state.files.filter((f) => f.parts && f.parts.length)); }

  async function zipFiles(done) {
    if (!done.length) return;
    await setBusy(true, 'Building ZIP');
    try {
      const zip = new JSZip();
      for (const f of done) {
        const dir = done.length > 1 ? zip.folder(baseName(f.name)) : zip;
        for (const p of f.parts) if (p.blob) dir.file(p.name, p.blob);
        dir.file(baseName(f.name) + '_chapters.txt', S.chaptersTxt(f.parts));
        dir.file(baseName(f.name) + '.cue', S.cue(f.parts, f.name));
        dir.file(baseName(f.name) + '_chapters.json', S.chaptersJson(f.parts));
        if (f.transcript && f.transcript.length) {
          dir.file(baseName(f.name) + '_transcript.txt', f.editedText || viewText(f, true));
          dir.file(baseName(f.name) + '.srt', S.srt(f.transcript));
          dir.file(baseName(f.name) + '.vtt', S.vtt(f.transcript));
        }
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (m) => progress(m.percent / 100, `Building ZIP ${Math.round(m.percent)}%`));
      download(blob, done.length > 1 ? 'split_parts.zip' : baseName(done[0].name) + '_parts.zip');
    } catch (e) {
      toast('ZIP failed: ' + (e.message || e));
    } finally {
      await setBusy(false);
    }
  }

  async function shareFiles(files, title) {
    try {
      await navigator.share({ files, title });
    } catch (e) {
      if (e.name !== 'AbortError') toast('Share failed: ' + e.message);
    }
  }

  // ---------- transcription ----------
  const KEY_STORE = 'm4asplit.groqKey';
  const SETTINGS_STORE = 'm4asplit.settings';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };

  function transcribeOptions() {
    return {
      apiKey: $('apiKey').value.trim(),
      model: $('model').value,
      language: $('language').value,
      prompt: $('glossary').value.trim(),
      endpoint: $('endpoint').value.trim() || Transcribe.GROQ_URL,
    };
  }

  function saveSettings() {
    store.set(SETTINGS_STORE, JSON.stringify({ model: $('model').value, language: $('language').value, glossary: $('glossary').value, endpoint: $('endpoint').value, unit: state.unit, len: $('lenInput').value }));
    store.set(KEY_STORE, $('rememberKey').checked ? $('apiKey').value.trim() || null : null);
    renderKeyState();
  }

  // Saved key: show a compact "saved" row instead of the input.
  let editingKey = false;
  function renderKeyState() {
    const saved = !!store.get(KEY_STORE) && !!$('apiKey').value.trim();
    const compact = saved && !editingKey;
    $('keySaved').classList.toggle('hidden', !compact);
    $('keyEntry').classList.toggle('hidden', compact);
    if (saved) $('keyHint').textContent = '…' + $('apiKey').value.trim().slice(-4);
  }
  function showKeyEntry() {
    editingKey = true;
    renderKeyState();
  }

  function updateCost() {
    const parts = state.files.flatMap((f) => f.parts || []);
    if (!parts.length) return ($('costEst').textContent = '');
    const cost = Transcribe.estimateCost(parts.map((p) => p.end - p.start), $('model').value);
    $('costEst').textContent = `${parts.length} parts · about $${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}`;
  }

  function renderStatus() {
    const rows = state.files.filter((f) => f.parts).flatMap((f) => f.parts.map((p) => ({ f, p })));
    $('statusList').innerHTML = rows.map(({ f, p }) => {
      const st = p.tStatus || 'queued';
      const cls = st === 'done' ? 'done' : st === 'failed' ? 'fail' : st === 'queued' ? '' : 'run';
      return `<li><span class="dot ${cls}"></span><span class="grow">${esc(p.name)}
        <span class="muted small">${esc(p.tNote || st)}</span></span>
        ${st === 'failed' ? `<button class="btn small" type="button" data-retry="${f.id}:${p.index}">Retry</button>` : ''}</li>`;
    }).join('');
  }

  const LANG_NAMES = { en: 'english', de: 'german', el: 'greek', es: 'spanish', ca: 'catalan', fr: 'french', it: 'italian', pt: 'portuguese' };
  const langLabel = (code) => (code ? $('language').querySelector(`option[value="${code}"]`)?.textContent || code : 'Auto-detect');
  const modelLabel = (m) => (m === 'whisper-large-v3' ? 'large v3' : 'large v3 turbo');
  const titleCase = (x) => x.charAt(0).toUpperCase() + x.slice(1);

  // Settings a part was transcribed with. Older transcripts only have Whisper's reported language.
  function usedWith(p) {
    const t = p.transcript;
    if (!t) return null;
    if (t.opts) return t.opts;
    const code = Object.keys(LANG_NAMES).find((k) => LANG_NAMES[k] === String(t.language || '').toLowerCase() || k === t.language);
    return { language: code || null, model: null, legacy: true };
  }
  // Does a finished part match the current Language / Model settings?
  function matchesSettings(p) {
    const u = usedWith(p);
    if (!u) return false;
    const lang = $('language').value, model = $('model').value;
    if (u.legacy) return !lang || u.language === lang; // model unknown for old transcripts
    return (u.language || '') === lang && u.model === model;
  }

  async function transcribe(onlyKeys, redo) {
    const opt = transcribeOptions();
    if (!opt.apiKey && opt.endpoint === Transcribe.GROQ_URL) { $('apiKey').focus(); return toast('Paste your Groq API key first'); }
    saveSettings();
    const jobs = [];
    for (const f of state.files) {
      if (!f.parts) continue;
      for (const p of f.parts) {
        const key = f.id + ':' + p.index;
        if (!p.blob) continue; // audio removed from the Library
        // Redo: every part not yet made with the current settings (old text stays until replaced).
        // redo 'all': every part. redo true: parts not made with the current settings.
        if (onlyKeys ? onlyKeys.includes(key) : redo === 'all' ? true : redo ? !(p.tStatus === 'done' && matchesSettings(p)) : p.tStatus !== 'done') {
          p.tStatus = 'queued'; p.tNote = '';
          jobs.push({ f, p });
        }
      }
    }
    if (!jobs.length) return toast(redo ? 'All parts already use these settings' : 'All parts are already transcribed. To change language or model, use Re-transcribe all.');
    renderStatus();
    await setBusy(true, `Transcribing 0 of ${jobs.length} parts`);
    let done = 0;
    try {
      await Transcribe.runQueue(jobs, 2, async ({ f, p }) => {
        if (state.abort.signal.aborted) return;
        p.tStatus = 'running'; p.tNote = 'Transcribing';
        renderStatus();
        try {
          const onNote = (note) => { p.tNote = note; renderStatus(); };
          const fresh = await Transcribe.transcribePart(p, opt, state.abort.signal, onNote);
          fresh.opts = { language: opt.language || null, model: opt.model, prompt: opt.prompt || '' };
          p.transcript = fresh;
          // Whisper sometimes skips the end or a stretch: check and re-send just that stretch once.
          let filled = 0;
          try {
            const an = f.analysis;
            filled = await Transcribe.fillGaps(p, opt, state.abort.signal, an ? (a, b) => soundIn(an, p.start + a, p.start + b) : null, onNote);
          } catch (e) {
            if (isAbort(e)) throw e;
            console.warn('Gap check failed', e);
          }
          p.tStatus = 'done';
          p.tNote = filled ? `done · filled ${filled} missing stretch${filled > 1 ? 'es' : ''}` : 'done';
          f.transcript = Transcribe.merge(f.parts);
          showTranscript(f.id);
          persistFile(f);
        } catch (e) {
          if (p.transcript && p.transcript.segments && p.transcript.segments.length) {
            // A redo that did not finish keeps the previous text.
            p.tStatus = 'done';
            p.tNote = isAbort(e) ? 'cancelled, kept previous text' : 'redo failed, kept previous text: ' + (e.status === 401 ? 'invalid API key' : e.message);
          } else {
            p.tStatus = isAbort(e) ? 'queued' : 'failed';
            p.tNote = isAbort(e) ? 'cancelled' : (e.status === 401 ? 'Invalid API key' : e.message);
          }
        }
        done++;
        progress(done / jobs.length, `Transcribed ${done} of ${jobs.length} parts`);
        renderStatus();
      });
    } finally {
      await setBusy(false);
      updateButtons();
    }
    if (!opt.language) {
      const touched = [...new Set(jobs.map((j) => j.f))];
      const langs = [...new Set(touched.flatMap((f) => f.parts.map((p) => p.transcript && p.transcript.language)).filter(Boolean))];
      $('langBanner').classList.toggle('hidden', langs.length < 2);
      $('langText').textContent = `Parts came back in different languages (${langs.join(', ')}). If the conversation is mainly one language, pick it under Language and transcribe again for better results.`;
    }
    if (state.current) showTranscript(state.current.id);
    const failed = jobs.filter((j) => j.p.tStatus === 'failed').length;
    if (failed) toast(`${failed} part${failed > 1 ? 's' : ''} failed. Tap Retry.`);
    else if (!state.abort.signal.aborted) toast('Transcript ready');
  }

  function transcriptFiles() { return state.files.filter((f) => f.transcript && f.transcript.length); }

  // Share of 10 ms frames in [t0, t1] that are clearly above the noise floor.
  function soundIn(an, t0, t1) {
    const i0 = Math.max(0, Math.floor(t0 / an.step)), i1 = Math.min(an.env.length, Math.ceil(t1 / an.step));
    if (i1 <= i0) return true;
    const thr = Math.pow(10, (an.floorDb + 10) / 10);
    let n = 0;
    for (let i = i0; i < i1; i++) if (an.env[i] > thr) n++;
    return n / (i1 - i0) > 0.05;
  }

  // Full transcript text in part order, with a visible line for every part that has no text yet.
  function viewText(f, withTimes) {
    return f.parts.map((p) => {
      if (p.transcript && p.transcript.segments.length) {
        return S.txt(p.transcript.segments.map((x) => ({ ...x, start: x.start + p.start, end: x.end + p.start })), withTimes).trim();
      }
      const why = !p.blob ? 'audio removed' : p.tStatus === 'failed' ? 'failed, tap Transcribe missing parts' : 'not transcribed yet';
      return `[Part ${p.index + 1} · ${S.clock(p.start)}–${S.clock(p.end)} · ${why}]`;
    }).join('\n\n') + '\n';
  }

  // Banner when the transcript was made with other settings than the ones selected now.
  function renderRedo(f) {
    const withText = f.parts.filter((p) => p.transcript && p.transcript.segments.length);
    const redoable = f.parts.filter((p) => p.blob);
    const stale = withText.filter((p) => !matchesSettings(p));
    const show = !!stale.length && !state.busy;
    $('redoBanner').classList.toggle('hidden', !show);
    const allDone = f.parts.length && f.parts.every((p) => p.tStatus === 'done');
    $('redoAllBtn').classList.toggle('hidden', !allDone || !redoable.length || state.busy);
    if (!show) return;
    const u = usedWith(stale[0]);
    const was = (u.language ? langLabel(u.language) : u.legacy && stale[0].transcript.language ? titleCase(String(stale[0].transcript.language)) : 'Auto-detect') + (u.model ? ' · ' + modelLabel(u.model) : '');
    const now = langLabel($('language').value) + ' · ' + modelLabel($('model').value);
    const cost = Transcribe.estimateCost(stale.filter((p) => p.blob).map((p) => p.end - p.start), $('model').value);
    const partial = stale.length < withText.length ? ` ${withText.length - stale.length} of ${withText.length} parts already use the new settings.` : '';
    $('redoText').textContent = redoable.length
      ? `Made with ${was}. Your settings now say ${now}.${partial} About $${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}.`
      : `Made with ${was}. The audio was removed, so it cannot be transcribed again.`;
    $('redoBtn').textContent = `Re-transcribe in ${langLabel($('language').value)}`;
    $('redoBtn').classList.toggle('hidden', !redoable.length);
  }

  function confirmRedo() {
    const parts = state.files.flatMap((f) => (f.parts || []).filter((p) => p.blob));
    if (!parts.length) return toast('The audio was removed, so it cannot be transcribed again.');
    const cost = Transcribe.estimateCost(parts.map((p) => p.end - p.start), $('model').value);
    const msg = `Re-transcribe ${parts.length} part${parts.length > 1 ? 's' : ''} with ${langLabel($('language').value)} · ${modelLabel($('model').value)}? About $${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}. The current text stays until each part is redone.`;
    if (confirm(msg)) transcribe(null, 'all');
  }

  function fitText() {
    const ta = $('transcriptText');
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 2 + 'px';
  }

  function showTranscript(fid) {
    const list = transcriptFiles();
    if (!list.length) return;
    const sel = $('transcriptFile');
    sel.innerHTML = list.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    sel.classList.toggle('hidden', list.length < 2);
    if (fid != null) sel.value = String(fid);
    if (!list.some((f) => String(f.id) === sel.value)) sel.value = String(list[0].id);
    const f = (state.current = list.find((x) => String(x.id) === sel.value));
    const fresh = viewText(f, $('showTimes').checked);
    // Never overwrite the user's own edits silently.
    if (f.editedText != null) {
      $('transcriptText').value = f.editedText;
      $('updateBanner').classList.toggle('hidden', f.editedText === fresh);
    } else {
      $('transcriptText').value = fresh;
      $('updateBanner').classList.add('hidden');
    }
    const done = f.parts.filter((p) => p.transcript && p.transcript.segments.length).length;
    const total = f.parts.length;
    const lastEnd = f.transcript.length ? f.transcript[f.transcript.length - 1].end : 0;
    const words = f.transcript.reduce((a, x) => a + (x.text.trim() ? x.text.trim().split(/\s+/).length : 0), 0);
    $('tStatusLine').textContent = `${done} of ${total} parts · text ends at ${S.clock(lastEnd)} of ${S.clock(f.parts[total - 1].end)} · ${words.toLocaleString()} words`;
    const missing = f.parts.filter((p) => !(p.transcript && p.transcript.segments.length) && p.blob).length;
    $('missingBanner').classList.toggle('hidden', !missing || state.busy);
    $('missingText').textContent = `${done} of ${total} parts transcribed.`;
    renderRedo(f);
    $('transcriptBox').classList.remove('hidden');
    requestAnimationFrame(fitText);
    $('shareTxtBtn').classList.toggle('hidden', !navigator.share);
  }

  function exportTranscript(fmt) {
    const f = state.current;
    if (!f) return;
    const b = baseName(f.name);
    if (fmt === 'txt') download(textBlob($('transcriptText').value), b + '_transcript.txt');
    if (fmt === 'srt') download(textBlob(S.srt(f.transcript)), b + '.srt');
    if (fmt === 'vtt') download(textBlob(S.vtt(f.transcript), 'text/vtt'), b + '.vtt');
    if (fmt === 'json') download(textBlob(JSON.stringify({ file: f.name, segments: f.transcript }, null, 2), 'application/json'), b + '_transcript.json');
  }

  // ---------- events ----------
  function bind() {
    const drop = $('drop');
    ['fileInput', 'fileInputMulti'].forEach((id) => $(id).addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; }));
    if (/Android/i.test(navigator.userAgent)) $('androidHelp').classList.remove('hidden');
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    $('fileList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove]');
      if (!b) return;
      const f = state.files.find((x) => x.id === +b.dataset.remove);
      if (f) revokeParts(f);
      state.files = state.files.filter((x) => x.id !== +b.dataset.remove);
      renderFiles();
      renderResults();
      if (!state.files.some((x) => x.parts)) $('resultsCard').classList.add('hidden');
      updateButtons();
      saveWorkspace(); // stays in the Library
    });

    $('unitSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) setUnit(b.dataset.unit);
    });
    $('pipeBtn').addEventListener('click', splitAndTranscribe);
    $('lenInput').addEventListener('change', saveSettings);
    $('quickBtn').addEventListener('click', () => split(false));
    $('smartBtn').addEventListener('click', () => split(true));

    $('results').addEventListener('click', (e) => {
      const play = e.target.closest('[data-play]');
      const dl = e.target.closest('[data-dl]');
      const chap = e.target.closest('[data-chap]');
      const lu = e.target.closest('[data-lufs]');
      if (play) {
        const { p } = findPart(play.dataset.play);
        const a = $('player');
        a.classList.remove('hidden');
        a.src = partUrl(p);
        a.play().catch(() => {});
      }
      if (dl) {
        const { p } = findPart(dl.dataset.dl + '');
        download(p.blob, p.name);
      }
      if (chap) {
        const f = state.files.find((x) => x.id === +chap.dataset.file);
        const b = baseName(f.name);
        if (chap.dataset.chap === 'copy') navigator.clipboard.writeText(S.chaptersTxt(f.parts)).then(() => toast('Chapter marks copied'), () => toast('Copy blocked by the browser'));
        if (chap.dataset.chap === 'txt') download(textBlob(S.chaptersTxt(f.parts)), b + '_chapters.txt');
        if (chap.dataset.chap === 'cue') download(textBlob(S.cue(f.parts, f.name)), b + '.cue');
        if (chap.dataset.chap === 'json') download(textBlob(S.chaptersJson(f.parts), 'application/json'), b + '_chapters.json');
      }
      if (lu) measureLoudness(state.files.find((x) => x.id === +lu.dataset.lufs));
    });
    $('zipBtn').addEventListener('click', zipAll);
    $('shareAllBtn').addEventListener('click', () => {
      const files = state.files.filter((f) => f.parts).flatMap((f) => f.parts.map((p) => new File([p.blob], p.name, { type: p.blob.type })));
      shareFiles(files, 'Audio parts');
    });
    $('resetBtn').addEventListener('click', () => {
      state.files.forEach(revokeParts);
      state.files = [];
      renderFiles();
      $('results').innerHTML = '';
      $('statusList').innerHTML = '';
      $('transcriptBox').classList.add('hidden');
      $('resultsCard').classList.add('hidden');
      updateButtons();
      $('player').pause();
      $('player').classList.add('hidden');
      $('restoredNote').classList.add('hidden');
      $('langBanner').classList.add('hidden');
      $('redoAllBtn').classList.add('hidden');
      state.current = null;
      saveWorkspace(); // everything stays in the Library
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    $('transcribeBtn').addEventListener('click', () => transcribe());
    $('stopBtn').addEventListener('click', () => state.abort && state.abort.abort());
    $('statusList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-retry]');
      if (b && !state.busy) transcribe([b.dataset.retry]);
    });
    $('model').addEventListener('change', () => { updateCost(); saveSettings(); });
    ['language', 'glossary', 'endpoint'].forEach((id) => $(id).addEventListener('change', saveSettings));
    $('rememberKey').addEventListener('change', saveSettings);
    $('apiKey').addEventListener('change', () => { editingKey = false; saveSettings(); });
    $('keyChange').addEventListener('click', () => { showKeyEntry(); $('apiKey').focus(); $('apiKey').select(); });
    $('keyForget').addEventListener('click', () => {
      store.set(KEY_STORE, null);
      $('apiKey').value = '';
      $('rememberKey').checked = false;
      showKeyEntry();
      toast('Key removed from this device');
    });
    $('settingsBtn').addEventListener('click', () => {
      $('transcribeCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      if ($('keyEntry').classList.contains('hidden')) $('keyChange').focus(); else $('apiKey').focus();
    });
    $('transcriptFile').addEventListener('change', () => showTranscript(+$('transcriptFile').value));
    $('transcriptText').addEventListener('input', () => {
      if (state.current) { state.current.editedText = $('transcriptText').value; persistFile(state.current); }
      fitText();
    });
    $('updateBtn').addEventListener('click', () => {
      if (state.current) { state.current.editedText = null; persistFile(state.current); showTranscript(state.current.id); }
    });
    $('missingBtn').addEventListener('click', () => { if (!state.busy) transcribe(); });
    $('redoBtn').addEventListener('click', () => { if (!state.busy) transcribe(null, true); });
    $('redoAllBtn').addEventListener('click', () => { if (!state.busy) confirmRedo(); });
    ['language', 'model'].forEach((id) => $(id).addEventListener('change', () => { if (state.current) showTranscript(state.current.id); }));
    window.addEventListener('resize', fitText);
    $('showTimes').addEventListener('change', () => showTranscript(state.current && state.current.id));
    $('copyBtn').addEventListener('click', () => navigator.clipboard.writeText($('transcriptText').value).then(() => toast('Transcript copied'), () => toast('Copy blocked by the browser')));
    $('shareTxtBtn').addEventListener('click', () => {
      const f = state.current;
      if (!f) return;
      const file = new File([textBlob($('transcriptText').value)], baseName(f.name) + '_transcript.txt', { type: 'text/plain' });
      if (canShareFiles([file])) shareFiles([file], f.name);
      else navigator.share({ title: f.name, text: $('transcriptText').value }).catch(() => {});
    });
    document.querySelectorAll('[data-fmt]').forEach((b) => b.addEventListener('click', () => exportTranscript(b.dataset.fmt)));
  }

  function setUnit(u) {
    state.unit = u;
    document.querySelectorAll('#unitSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.unit === u)));
    $('lenLabel').textContent = u === 'min' ? 'minutes per part' : u === 'sec' ? 'seconds per part' : 'MB per part';
    saveSettings();
  }

  function restoreSettings() {
    // Key first: setUnit() below saves settings, which would otherwise clear it.
    const key = store.get(KEY_STORE);
    if (key) { $('apiKey').value = key; $('rememberKey').checked = true; }
    let s = {};
    try { s = JSON.parse(store.get(SETTINGS_STORE) || '{}'); } catch (e) { /* ignore */ }
    if (s.model) $('model').value = s.model;
    if (s.language != null) $('language').value = s.language;
    if (s.glossary) $('glossary').value = s.glossary;
    $('endpoint').value = s.endpoint || '';
    $('endpoint').placeholder = Transcribe.GROQ_URL;
    if (s.len) $('lenInput').value = s.len;
    if (s.unit) setUnit(s.unit);
    renderKeyState();
  }

  // ---------- PWA: install, service worker, share target ----------
  function setupPwa() {
    let deferred = null;
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (standalone) $('installBtn').classList.add('hidden');
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
    });
    window.addEventListener('appinstalled', () => $('installBtn').classList.add('hidden'));
    $('installBtn').addEventListener('click', async () => {
      if (deferred) {
        deferred.prompt();
        const choice = await deferred.userChoice;
        deferred = null;
        if (choice.outcome === 'accepted') $('installBtn').classList.add('hidden');
        return;
      }
      $('installSteps').innerHTML = installHelp();
      const dlg = $('installDlg');
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    });
    $('installClose').addEventListener('click', () => { const d = $('installDlg'); d.close ? d.close() : d.removeAttribute('open'); });
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    // Files shared from another app (Android share sheet) are parked in a cache by sw.js.
    if (new URLSearchParams(location.search).has('shared') && 'caches' in window) {
      history.replaceState(null, '', location.pathname);
      caches.open('share-inbox').then(async (c) => {
        const reqs = await c.keys();
        const files = [];
        for (const r of reqs) {
          const res = await c.match(r);
          const name = decodeURIComponent(res.headers.get('x-name') || 'shared.m4a');
          files.push(new File([await res.blob()], name, { type: res.headers.get('content-type') || 'audio/mp4' }));
          await c.delete(r);
        }
        if (files.length) addFiles(files);
      });
    }
  }

  function installHelp() {
    const ua = navigator.userAgent;
    const android = /Android/i.test(ua), ios = /iPhone|iPad|iPod/i.test(ua);
    const firefox = /Firefox|FxiOS/i.test(ua);
    if (location.protocol === 'file:') {
      return '<p>Install works from the online version. Open <a href="https://gitgt1.github.io/m4a-splitter/">gitgt1.github.io/m4a-splitter</a> in Chrome or Edge.</p>';
    }
    if (android && firefox) {
      return '<ol><li>Tap the ⋮ menu.</li><li>Tap <b>Add to Home screen</b> (or <b>Install</b>).</li></ol><p class="muted small">Firefox does not support sharing a recording straight into the app. For Share → Splitter from your recorder, open this page in <b>Chrome</b> and install from there.</p>';
    }
    if (firefox) {
      return '<p>Firefox on computers cannot install web apps. Everything still works in this tab, so a bookmark is enough.</p><p class="muted small">To get an app icon, open this page in <b>Chrome</b> or <b>Edge</b> and click the install icon in the address bar.</p>';
    }
    if (ios) {
      return '<ol><li>Tap the <b>Share</b> button in Safari.</li><li>Tap <b>Add to Home Screen</b>.</li></ol>';
    }
    if (android) {
      return '<ol><li>Tap the ⋮ menu in Chrome.</li><li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li></ol><p class="muted small">Then in your recorder app: Share → Splitter.</p>';
    }
    return '<ol><li>In Chrome or Edge, click the install icon at the right end of the address bar.</li><li>Or open the browser menu → <b>Install M4A Splitter</b>.</li></ol>';
  }

  // ---------- Library ----------
  const WS_STORE = 'm4asplit.workspace';

  function toEntry(f) {
    return {
      id: f.entryId, title: f.title, name: f.name, mode: f.mode, aac: !!f.aac,
      createdAt: f.createdAt, duration: f.parts[f.parts.length - 1].end, audioRemoved: !!f.audioRemoved,
      editedText: f.editedText == null ? null : f.editedText,
      parts: f.parts.map((p) => ({
        index: p.index, start: p.start, end: p.end, snapped: p.snapped, blob: p.blob || null, size: p.size,
        name: p.name, lufs: p.lufs, transcript: p.transcript || null, tStatus: p.tStatus === 'done' ? 'done' : null,
      })),
    };
  }

  // Save one recording to the Library (creates the entry on first save).
  function persistFile(f) {
    if (!f.parts || !f.parts.length) return;
    if (!f.entryId) {
      f.entryId = Library.newId();
      f.createdAt = Date.now();
      f.title = f.title || baseName(f.name);
      Library.persist();
    }
    Library.save(toEntry(f)).then(refreshLibCount);
    saveWorkspace();
  }

  // Which Library entries are open on the New tab, so a reload or killed tab comes back.
  function saveWorkspace() {
    store.set(WS_STORE, JSON.stringify(state.files.filter((f) => f.entryId).map((f) => f.entryId)));
  }

  function fileFromEntry(e) {
    const parts = e.parts.map((p) => ({ ...p, tStatus: p.tStatus === 'done' ? 'done' : undefined, tNote: p.tStatus === 'done' ? 'done' : !p.blob ? 'audio removed' : '' }));
    return {
      id: nextId++, entryId: e.id, title: e.title, name: e.name, mode: e.mode, aac: e.aac, restored: true,
      createdAt: e.createdAt, audioRemoved: !!e.audioRemoved, editedText: e.editedText == null ? null : e.editedText, parts,
      duration: e.duration, transcript: Transcribe.merge(parts),
      info: `${S.clock(e.duration)} · ${parts.length} parts${e.audioRemoved ? ' · audio removed' : ''}`, status: 'From Library',
    };
  }

  function openEntries(entries) {
    for (const e of entries) {
      if (state.files.some((f) => f.entryId === e.id)) continue;
      state.files.push(fileFromEntry(e));
    }
    renderFiles();
    renderResults();
    renderStatus();
    updateCost();
    if (state.files.some((f) => f.parts)) $('resultsCard').classList.remove('hidden');
    $('restoredNote').classList.toggle('hidden', !state.files.some((f) => f.restored));
    if (transcriptFiles().length) showTranscript(entries.length ? state.files.find((f) => f.entryId === entries[entries.length - 1].id).id : undefined);
    updateButtons();
    saveWorkspace();
  }

  async function startLibrary() {
    let ids = [];
    try { ids = JSON.parse(store.get(WS_STORE) || '[]'); } catch (e) { /* ignore */ }
    ids = ids.concat(await Library.migrate().catch(() => []));
    await Library.cleanup().catch(() => 0);
    if (ids.length && !state.files.length) {
      const entries = (await Promise.all(ids.map((id) => Library.get(id)))).filter(Boolean);
      if (entries.length) openEntries(entries);
    }
    refreshLibCount();
  }

  async function refreshLibCount() {
    const all = await Library.list();
    $('libCount').textContent = all.length;
    if (!$('libView').classList.contains('hidden')) renderLibrary(all);
  }

  function showView(lib) {
    $('newView').classList.toggle('hidden', lib);
    $('libView').classList.toggle('hidden', !lib);
    $('tabNew').setAttribute('aria-selected', String(!lib));
    $('tabLib').setAttribute('aria-selected', String(lib));
    if (lib) renderLibrary();
    window.scrollTo({ top: 0 });
  }

  const entryText = (e, times = true) => {
    if (e.editedText) return e.editedText;
    return viewText({ parts: e.parts.map((p) => ({ ...p, tStatus: p.tStatus })) }, times);
  };
  const entryDone = (e) => e.parts.filter((p) => p.transcript && p.transcript.segments.length).length;

  function snippet(text, q) {
    const flat = text.replace(/\[\d+:\d\d:\d\d\]\s*/g, '').replace(/\s+/g, ' ').trim();
    if (!q) return esc(flat.slice(0, 220));
    const i = flat.toLowerCase().indexOf(q);
    if (i < 0) return esc(flat.slice(0, 220));
    const a = Math.max(0, i - 80);
    const part = flat.slice(a, i + q.length + 140);
    const j = i - a;
    return (a ? '…' : '') + esc(part.slice(0, j)) + '<mark>' + esc(part.slice(j, j + q.length)) + '</mark>' + esc(part.slice(j + q.length));
  }

  async function renderLibrary(all) {
    all = all || (await Library.list());
    const q = $('libSearch').value.trim().toLowerCase();
    const rows = all.filter((e) => !q || (e.title || '').toLowerCase().includes(q) || entryText(e, false).toLowerCase().includes(q));
    const date = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    $('libList').innerHTML = rows.length ? rows.map((e) => {
      const done = entryDone(e), n = e.parts.length;
      const audioUntil = new Date(e.createdAt + Library.AUDIO_DAYS * 864e5).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      const hasText = done > 0;
      return `<div class="entry" data-id="${e.id}">
        <input class="title" value="${esc(e.title || e.name)}" data-title="${e.id}" aria-label="Title">
        <div class="meta">${date(e.createdAt)} · ${S.clock(e.duration)} · transcribed ${done}/${n} · ${e.audioRemoved ? 'audio removed' : 'audio kept until ' + audioUntil}</div>
        ${hasText ? `<div class="snippet">${snippet(entryText(e, false), q)}</div>` : '<div class="snippet muted">No transcript yet.</div>'}
        <div class="actions">
          <button class="btn small" type="button" data-act="open">Open</button>
          ${hasText ? `<button class="btn small" type="button" data-act="copy">Copy text</button>
          ${navigator.share ? '<button class="btn small" type="button" data-act="share">Share</button>' : ''}
          <button class="btn small" type="button" data-act="txt">.txt</button>
          <button class="btn small" type="button" data-act="srt">.srt</button>
          <button class="btn small" type="button" data-act="vtt">.vtt</button>
          <button class="btn small" type="button" data-act="json">.json</button>` : ''}
          ${e.audioRemoved ? '' : `<button class="btn small" type="button" data-act="zip">Audio ZIP</button>
          <button class="btn small" type="button" data-act="noaudio">Delete audio</button>`}
          <button class="btn small" type="button" data-act="delete">Delete</button>
        </div>
      </div>`;
    }).join('') : `<div class="empty">${q ? 'Nothing matches “' + esc(q) + '”.' : 'Finished recordings appear here automatically.'}</div>`;
    const used = await Library.usage();
    $('libStorage').textContent = `${all.length} recording${all.length === 1 ? '' : 's'}${used != null ? ' · ' + fmtSize(used) + ' used on this device' : ''} · audio is removed after ${Library.AUDIO_DAYS} days, transcripts are kept.`;
  }

  async function libraryAction(id, act) {
    const e = await Library.get(id);
    if (!e) return;
    const b = (e.title || baseName(e.name)).replace(/[\\/:*?"<>|]+/g, '_');
    const segs = Transcribe.merge(e.parts);
    if (act === 'open') { showView(false); openEntries([e]); $('resultsCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    if (act === 'copy') navigator.clipboard.writeText(entryText(e)).then(() => toast('Transcript copied'), () => toast('Copy blocked by the browser'));
    if (act === 'share') {
      const file = new File([textBlob(entryText(e))], b + '_transcript.txt', { type: 'text/plain' });
      if (canShareFiles([file])) shareFiles([file], e.title);
      else navigator.share({ title: e.title, text: entryText(e) }).catch(() => {});
    }
    if (act === 'txt') download(textBlob(entryText(e)), b + '_transcript.txt');
    if (act === 'srt') download(textBlob(S.srt(segs)), b + '.srt');
    if (act === 'vtt') download(textBlob(S.vtt(segs), 'text/vtt'), b + '.vtt');
    if (act === 'json') download(textBlob(JSON.stringify({ title: e.title, file: e.name, segments: segs }, null, 2), 'application/json'), b + '_transcript.json');
    if (act === 'zip') zipFiles([fileFromEntry(e)]);
    if (act === 'noaudio') {
      if (!confirm('Delete the audio of “' + e.title + '”? The transcript is kept.')) return;
      await Library.removeAudio(id);
      dropFromWorkspace(id);
      toast('Audio deleted, transcript kept');
    }
    if (act === 'delete') {
      if (!confirm('Delete “' + e.title + '” with its transcript? This cannot be undone.')) return;
      await Library.remove(id);
      dropFromWorkspace(id);
      toast('Deleted');
    }
    refreshLibCount();
  }

  // If an entry changed in the Library, close it on the New tab (it can be reopened).
  function dropFromWorkspace(id) {
    const f = state.files.find((x) => x.entryId === id);
    if (!f) return;
    revokeParts(f);
    state.files = state.files.filter((x) => x !== f);
    if (state.current === f) state.current = null;
    renderFiles();
    renderResults();
    renderStatus();
    if (!state.files.some((x) => x.parts)) { $('resultsCard').classList.add('hidden'); $('transcriptBox').classList.add('hidden'); }
    else if (transcriptFiles().length) showTranscript();
    saveWorkspace();
  }

  function bindLibrary() {
    $('tabNew').addEventListener('click', () => showView(false));
    $('tabLib').addEventListener('click', () => showView(true));
    $('libSearch').addEventListener('input', () => renderLibrary());
    $('libList').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (b) libraryAction(b.closest('.entry').dataset.id, b.dataset.act);
    });
    $('libList').addEventListener('change', async (ev) => {
      const t = ev.target.closest('[data-title]');
      if (!t) return;
      const e = await Library.get(t.dataset.title);
      if (!e) return;
      e.title = t.value.trim() || baseName(e.name);
      await Library.put(e);
      const f = state.files.find((x) => x.entryId === e.id);
      if (f) { f.title = e.title; renderResults(); }
      toast('Renamed');
    });
  }

  bind();
  bindLibrary();
  restoreSettings();
  updateButtons();
  startLibrary();
  setupPwa();
  window.__app = state; // handy for debugging and tests
})();
