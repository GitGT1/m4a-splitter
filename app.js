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
    if (on) progress(0, text || 'Working');
    updateButtons();
    try {
      if (on && navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { /* wake lock is a nice-to-have */ }
  }
  function progress(frac, text) {
    $('barFill').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    if (text) $('progressText').textContent = text;
  }
  document.addEventListener('visibilitychange', async () => {
    if (state.busy && document.visibilityState === 'visible' && navigator.wakeLock && !wakeLock) {
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
        f.error = 'Cannot read this file: ' + (e.message || e);
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
            ${f.status && !f.error && f.info ? `<span class="tag ${f.mode === 'copy' ? 'ok' : ''}">${esc(f.status)}</span>` : ''}</div>
        </div>
        <button class="btn icon" type="button" data-remove="${f.id}" aria-label="Remove ${esc(f.name)}" ${state.busy ? 'disabled' : ''}>✕</button>
      </li>`).join('');
    updateButtons();
  }

  function readyFiles() { return state.files.filter((f) => !f.error && f.duration); }

  function updateButtons() {
    const ok = readyFiles().length > 0 && !state.busy;
    $('quickBtn').disabled = !ok;
    $('smartBtn').disabled = !ok;
    document.querySelectorAll('[data-remove]').forEach((b) => (b.disabled = state.busy));
    $('transcribeBtn').disabled = state.busy;
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
    const an = new Analysis.Analyzer();
    const ok = await M4A.decodeStream(f.demux, (ch, n, sr) => an.push(ch, n, sr), (p) => progress(p * 0.8, `${label}: analysing audio ${Math.round(p * 100)}%`));
    if (ok) {
      f.analysis = an.finish();
      return f.analysis;
    }
    // No WebCodecs AAC decoder: try decoding the whole file at once.
    progress(0.3, label + ': analysing audio');
    try {
      const buf = await M4A.decodeWhole(await f.file.arrayBuffer());
      f.analysis = Analysis.analyzeBuffer(buf);
    } catch (e) {
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
    await setBusy(true, 'Starting');
    try {
      for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi];
        const label = files.length > 1 ? `File ${fi + 1}/${files.length}` : 'Splitting';
        revokeParts(f);
        if (smart && !(await analyze(f, label))) {
          toast('This browser cannot decode AAC, so cuts are at exact times. Use Chrome, Edge or Safari for Smart split.');
        }
        const plan = planParts(f, state.unit, value, smart);
        const pad = String(plan.length).length < 2 ? 2 : String(plan.length).length;
        const ext = f.mode === 'copy' || f.aac ? 'm4a' : 'wav';
        f.parts = [];
        for (let i = 0; i < plan.length; i++) {
          const p = plan[i];
          progress((smart ? 0.8 : 0) + ((i + 1) / plan.length) * (smart ? 0.2 : 1), `${label}: writing part ${i + 1} of ${plan.length}`);
          await tick();
          let blob;
          if (f.mode === 'copy') blob = M4A.muxFrames(f.demux, p.from, p.to);
          else if (f.aac) blob = await M4A.aacBlob(f.pcm, p.from, p.to);
          else blob = M4A.wavBlob(f.pcm, p.from, p.to);
          f.parts.push({
            index: i, start: p.start, end: p.end, snapped: p.snapped, blob, size: blob.size,
            name: `${baseName(f.name)}_part${String(i + 1).padStart(pad, '0')}.${ext}`,
            lufs: f.analysis ? Analysis.lufs(f.analysis, p.start, p.end) : undefined,
          });
        }
        f.transcript = null;
      }
      renderResults();
      $('resultsCard').classList.remove('hidden');
      $('transcribeCard').classList.remove('hidden');
      updateCost();
      $('resultsCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      console.error(e);
      toast('Split failed: ' + (e.message || e));
    } finally {
      await setBusy(false);
    }
  }

  async function measureLoudness(f) {
    await setBusy(true, 'Measuring loudness');
    try {
      if (!(await analyze(f, 'Loudness'))) return toast('This browser cannot decode AAC, so loudness is unavailable.');
      for (const p of f.parts) p.lufs = Analysis.lufs(f.analysis, p.start, p.end);
      renderResults();
    } catch (e) {
      toast('Could not measure: ' + (e.message || e));
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
        <h3>${esc(f.name)}</h3>
        <div class="muted small">${f.parts.length} parts · ${f.mode === 'copy' ? 'lossless copy' : f.aac ? 're-encoded AAC' : 'WAV'}</div>
        <table class="parts">
          <thead><tr><th>#</th><th>Start – end</th><th class="hide-sm">Length</th><th>Size</th>${hasLufs ? '<th class="hide-sm">LUFS</th>' : ''}<th></th></tr></thead>
          <tbody>${f.parts.map((p) => `<tr>
            <td>${p.index + 1}</td>
            <td>${S.clock(p.start)} – ${S.clock(p.end)}${p.snapped === 'pause' ? '<span class="tag ok">pause</span>' : p.snapped === 'quietest' ? '<span class="tag">quiet</span>' : ''}</td>
            <td class="hide-sm">${S.clock(p.end - p.start)}</td>
            <td>${fmtSize(p.size)}</td>
            ${hasLufs ? `<td class="hide-sm">${p.lufs == null ? '–' : p.lufs.toFixed(1)}</td>` : ''}
            <td class="act">
              <button class="btn icon" type="button" data-play="${f.id}:${p.index}" aria-label="Play part ${p.index + 1}">▶</button>
              <button class="btn icon" type="button" data-dl="${f.id}:${p.index}" aria-label="Download part ${p.index + 1}">↓</button>
            </td></tr>`).join('')}</tbody>
        </table>
        <div class="actions">
          <button class="btn small" type="button" data-chap="copy" data-file="${f.id}">Copy chapter marks</button>
          <button class="btn small" type="button" data-chap="txt" data-file="${f.id}">Chapters .txt</button>
          <button class="btn small" type="button" data-chap="cue" data-file="${f.id}">CUE sheet</button>
          <button class="btn small" type="button" data-chap="json" data-file="${f.id}">Chapters JSON</button>
          ${hasLufs ? '' : `<button class="btn small" type="button" data-lufs="${f.id}">Measure loudness</button>`}
        </div>
      </div>`;
    }).join('');
    const all = done.flatMap((f) => f.parts.map((p) => new File([p.blob], p.name, { type: p.blob.type })));
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

  async function zipAll() {
    const done = state.files.filter((f) => f.parts && f.parts.length);
    if (!done.length) return;
    await setBusy(true, 'Building ZIP');
    try {
      const zip = new JSZip();
      for (const f of done) {
        const dir = done.length > 1 ? zip.folder(baseName(f.name)) : zip;
        for (const p of f.parts) dir.file(p.name, p.blob);
        dir.file(baseName(f.name) + '_chapters.txt', S.chaptersTxt(f.parts));
        dir.file(baseName(f.name) + '.cue', S.cue(f.parts, f.name));
        dir.file(baseName(f.name) + '_chapters.json', S.chaptersJson(f.parts));
        if (f.transcript && f.transcript.length) {
          dir.file(baseName(f.name) + '_transcript.txt', S.txt(f.transcript, true));
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
    store.set(KEY_STORE, $('rememberKey').checked ? $('apiKey').value.trim() : null);
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

  async function transcribe(onlyKeys) {
    const opt = transcribeOptions();
    if (!opt.apiKey && opt.endpoint === Transcribe.GROQ_URL) { $('apiKey').focus(); return toast('Paste your Groq API key first'); }
    saveSettings();
    const jobs = [];
    for (const f of state.files) {
      if (!f.parts) continue;
      for (const p of f.parts) {
        const key = f.id + ':' + p.index;
        if (onlyKeys ? onlyKeys.includes(key) : p.tStatus !== 'done') {
          p.tStatus = 'queued'; p.tNote = '';
          jobs.push({ f, p });
        }
      }
    }
    if (!jobs.length) return toast('All parts are already transcribed');
    renderStatus();
    state.abort = new AbortController();
    $('cancelBtn').classList.remove('hidden');
    await setBusy(true, 'Transcribing');
    let done = 0;
    try {
      await Transcribe.runQueue(jobs, 2, async ({ f, p }) => {
        if (state.abort.signal.aborted) return;
        p.tStatus = 'running'; p.tNote = 'Transcribing';
        renderStatus();
        try {
          p.transcript = await Transcribe.transcribePart(p, opt, state.abort.signal, (note) => { p.tNote = note; renderStatus(); });
          p.tStatus = 'done';
          p.tNote = 'done';
          f.transcript = Transcribe.merge(f.parts);
          showTranscript(f.id);
        } catch (e) {
          p.tStatus = e.name === 'AbortError' ? 'queued' : 'failed';
          p.tNote = e.name === 'AbortError' ? 'cancelled' : (e.status === 401 ? 'Invalid API key' : e.message);
        }
        done++;
        progress(done / jobs.length, `Transcribed ${done} of ${jobs.length} parts`);
        renderStatus();
      });
    } finally {
      $('cancelBtn').classList.add('hidden');
      await setBusy(false);
    }
    const failed = jobs.filter((j) => j.p.tStatus === 'failed').length;
    if (failed) toast(`${failed} part${failed > 1 ? 's' : ''} failed. Tap Retry.`);
    else if (!state.abort.signal.aborted) toast('Transcript ready');
  }

  function transcriptFiles() { return state.files.filter((f) => f.transcript && f.transcript.length); }

  function showTranscript(fid) {
    const list = transcriptFiles();
    if (!list.length) return;
    const sel = $('transcriptFile');
    sel.innerHTML = list.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    sel.classList.toggle('hidden', list.length < 2);
    if (fid != null) sel.value = String(fid);
    if (!list.some((f) => String(f.id) === sel.value)) sel.value = String(list[0].id);
    state.current = list.find((f) => String(f.id) === sel.value);
    const editing = document.activeElement === $('transcriptText');
    if (!editing) $('transcriptText').value = S.txt(state.current.transcript, $('showTimes').checked);
    $('transcriptBox').classList.remove('hidden');
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
    $('fileInput').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
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
      if (!state.files.some((x) => x.parts)) { $('resultsCard').classList.add('hidden'); $('transcribeCard').classList.add('hidden'); }
    });

    $('unitSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) setUnit(b.dataset.unit);
    });
    $('presetBtn').addEventListener('click', () => {
      // About 10 min, but never over ~20 MB, so every part fits Groq's upload limit.
      setUnit('min');
      const kbps = Math.max(...readyFiles().map((f) => (f.mode === 'copy' ? f.demux.meta.bitrate / 1000 : 128)), 128);
      const maxMin = (20e6 * 8) / (kbps * 1000) / 60;
      $('lenInput').value = Math.max(1, Math.min(10, Math.floor(maxMin)));
      saveSettings();
      if (readyFiles().length && !state.busy) split(true);
      else toast('Preset set. Add a file, then tap Smart split.');
    });
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
      $('transcribeCard').classList.add('hidden');
      $('player').pause();
      $('player').classList.add('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    $('transcribeBtn').addEventListener('click', () => transcribe());
    $('cancelBtn').addEventListener('click', () => state.abort && state.abort.abort());
    $('statusList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-retry]');
      if (b && !state.busy) transcribe([b.dataset.retry]);
    });
    $('model').addEventListener('change', () => { updateCost(); saveSettings(); });
    ['language', 'glossary', 'endpoint'].forEach((id) => $(id).addEventListener('change', saveSettings));
    $('rememberKey').addEventListener('change', saveSettings);
    $('apiKey').addEventListener('change', saveSettings);
    $('transcriptFile').addEventListener('change', () => showTranscript(+$('transcriptFile').value));
    $('showTimes').addEventListener('change', () => { $('transcriptText').blur(); showTranscript(state.current && state.current.id); });
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
    let s = {};
    try { s = JSON.parse(store.get(SETTINGS_STORE) || '{}'); } catch (e) { /* ignore */ }
    if (s.model) $('model').value = s.model;
    if (s.language != null) $('language').value = s.language;
    if (s.glossary) $('glossary').value = s.glossary;
    $('endpoint').value = s.endpoint || '';
    $('endpoint').placeholder = Transcribe.GROQ_URL;
    if (s.len) $('lenInput').value = s.len;
    if (s.unit) setUnit(s.unit);
    const key = store.get(KEY_STORE);
    if (key) { $('apiKey').value = key; $('rememberKey').checked = true; }
  }

  // ---------- PWA: install, service worker, share target ----------
  function setupPwa() {
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      $('installBtn').classList.remove('hidden');
    });
    $('installBtn').addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      $('installBtn').classList.add('hidden');
    });
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

  bind();
  restoreSettings();
  setupPwa();
  window.__app = state; // handy for debugging and tests
})();
