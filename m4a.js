/* M4A demux / lossless mux, plus a PCM fallback for files that cannot be copied frame by frame. */
(function () {
  'use strict';

  // Find the AudioSpecificConfig (DecoderSpecificInfo, tag 5) inside an esds box.
  function findAsc(desc) {
    if (!desc) return null;
    if (desc.tag === 5 && desc.data) return new Uint8Array(desc.data);
    for (const d of desc.descs || []) {
      const r = findAsc(d);
      if (r) return r;
    }
    return null;
  }

  // Parse an M4A/MP4 file. Resolves with track info and every AAC frame, or rejects
  // when the file is not AAC-in-MP4 (caller then uses the PCM fallback).
  function demux(arrayBuffer) {
    return new Promise((resolve, reject) => {
      const file = MP4Box.createFile();
      let track = null;
      let meta = null;
      const samples = [];
      file.onError = (e) => reject(new Error('Cannot read container: ' + e));
      file.onReady = (info) => {
        track = info.audioTracks && info.audioTracks[0];
        if (!track) return reject(new Error('No audio track found'));
        if (!/^mp4a\./.test(track.codec)) return reject(new Error('Codec ' + track.codec + ' is not AAC'));
        const trak = file.getTrackById(track.id);
        const entry = trak.mdia.minf.stbl.stsd.entries[0];
        const asc = entry.esds && entry.esds.esd ? findAsc(entry.esds.esd) : null;
        if (!asc) return reject(new Error('Missing AAC decoder config'));
        meta = {
          codec: track.codec,
          sampleRate: track.audio.sample_rate,
          channels: track.audio.channel_count,
          timescale: track.timescale,
          nbSamples: track.nb_samples,
          asc,
        };
        file.setExtractionOptions(track.id, null, { nbSamples: 5000 });
        file.start();
      };
      file.onSamples = (id, user, list) => {
        for (const s of list) samples.push({ data: s.data, duration: s.duration, size: s.size });
        file.releaseUsedSamples(id, list[list.length - 1].number + 1);
      };
      arrayBuffer.fileStart = 0;
      try {
        file.appendBuffer(arrayBuffer);
        file.flush();
      } catch (e) {
        return reject(e);
      }
      if (!meta) return reject(new Error('Not an MP4/M4A file'));
      if (!samples.length) return reject(new Error('No audio frames found'));

      // Frame start times in seconds, plus one entry for the end of the file.
      const starts = new Float64Array(samples.length + 1);
      let t = 0;
      for (let i = 0; i < samples.length; i++) {
        starts[i] = t / meta.timescale;
        t += samples[i].duration;
      }
      starts[samples.length] = t / meta.timescale;
      meta.duration = starts[samples.length];
      let bytes = 0;
      for (const s of samples) bytes += s.size;
      meta.audioBytes = bytes;
      meta.bitrate = meta.duration > 0 ? (bytes * 8) / meta.duration : 0;
      resolve({ meta, samples, starts });
    });
  }

  // Write frames [from, to) into a new M4A file without re-encoding.
  function muxFrames(d, from, to) {
    const { meta, samples } = d;
    const target = new Mp4Muxer.ArrayBufferTarget();
    const muxer = new Mp4Muxer.Muxer({
      target,
      audio: { codec: 'aac', numberOfChannels: meta.channels, sampleRate: meta.sampleRate },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    let ts = 0;
    for (let i = from; i < to; i++) {
      const s = samples[i];
      const dur = (s.duration / meta.timescale) * 1e6;
      const m = i === from ? {
        decoderConfig: {
          codec: meta.codec,
          numberOfChannels: meta.channels,
          sampleRate: meta.sampleRate,
          description: meta.asc,
        },
      } : undefined;
      muxer.addAudioChunkRaw(s.data, 'key', ts, dur, m);
      ts += dur;
    }
    muxer.finalize();
    return new Blob([target.buffer], { type: 'audio/mp4' });
  }

  // Estimated output size of frames [from, to): payload + sample table + headers.
  function frameBytes(d, from, to) {
    let b = 1200;
    for (let i = from; i < to; i++) b += d.samples[i].size + 4;
    return b;
  }

  // Nearest frame index to time t (binary search on frame starts).
  function frameAt(d, t) {
    const s = d.starts;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid] < t) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(s[lo - 1] - t) <= Math.abs(s[lo] - t)) lo--;
    return lo;
  }

  // Stream-decode every frame with WebCodecs and hand PCM to onPcm(channels[], length, sampleRate).
  // Keeps memory flat on phones: nothing but the current block is ever held.
  async function decodeStream(d, onPcm, onProgress, signal) {
    if (typeof AudioDecoder === 'undefined') return false;
    const { meta, samples } = d;
    const cfg = { codec: meta.codec, sampleRate: meta.sampleRate, numberOfChannels: meta.channels, description: meta.asc };
    try {
      const sup = await AudioDecoder.isConfigSupported(cfg);
      if (!sup.supported) return false;
    } catch (e) {
      return false;
    }
    let error = null, outputs = 0;
    const dec = new AudioDecoder({
      output: (ad) => {
        outputs++;
        try {
          const n = ad.numberOfFrames, ch = ad.numberOfChannels;
          const chans = [];
          if (ad.format === 'f32-planar') {
            for (let c = 0; c < ch; c++) {
              const a = new Float32Array(n);
              ad.copyTo(a, { planeIndex: c });
              chans.push(a);
            }
          } else {
            try {
              for (let c = 0; c < ch; c++) {
                const a = new Float32Array(n);
                ad.copyTo(a, { planeIndex: c, format: 'f32-planar' });
                chans.push(a);
              }
            } catch (e) {
              // Interleaved f32 fallback.
              const inter = new Float32Array(n * ch);
              ad.copyTo(inter, { planeIndex: 0, format: 'f32' });
              for (let c = 0; c < ch; c++) {
                const a = new Float32Array(n);
                for (let i = 0; i < n; i++) a[i] = inter[i * ch + c];
                chans.push(a);
              }
            }
          }
          onPcm(chans, n, ad.sampleRate);
        } catch (e) {
          error = e;
        } finally {
          ad.close();
        }
      },
      error: (e) => { error = e; },
    });
    dec.configure(cfg);
    const t0 = Date.now();
    const stop = () => { try { if (dec.state !== 'closed') dec.close(); } catch (e) { /* closed */ } };
    let ts = 0;
    for (let i = 0; i < samples.length; i++) {
      if (error) break;
      if (signal && signal.aborted) { stop(); throw new DOMException('Cancelled', 'AbortError'); }
      // Some phone decoders accept input but never produce output: give up and use the fallback.
      if (outputs === 0 && i > 200 && Date.now() - t0 > 6000) { stop(); return false; }
      const s = samples[i];
      const dur = (s.duration / meta.timescale) * 1e6;
      dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(ts), duration: Math.round(dur), data: s.data }));
      ts += dur;
      if (dec.decodeQueueSize > 48) {
        await new Promise((r) => {
          const done = () => { dec.removeEventListener('dequeue', done); clearTimeout(t); r(); };
          const t = setTimeout(done, 50); // never wait on a dequeue event that may not come
          if ('ondequeue' in dec) dec.addEventListener('dequeue', done);
        });
      }
      if (i % 2000 === 0) {
        onProgress && onProgress(i / samples.length);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (!error) {
      const flushed = await Promise.race([dec.flush().then(() => true), new Promise((r) => setTimeout(() => r(false), 20000))]);
      if (!flushed) { stop(); return false; }
    }
    stop();
    if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (error) { console.warn('AudioDecoder failed, using fallback', error); return false; }
    if (outputs === 0) return false;
    onProgress && onProgress(1);
    return true;
  }

  // Fallback for browsers without a working WebCodecs AAC decoder (e.g. Firefox on Android):
  // re-wrap ~20 s of frames as a tiny M4A (lossless) and decode it with decodeAudioData.
  // Progress per chunk and flat memory, unlike decoding the whole file at once.
  async function decodeChunked(d, onPcm, onProgress, signal) {
    const n = d.samples.length;
    const per = Math.max(64, Math.round((20 * d.meta.sampleRate) / 1024));
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(1, 1, d.meta.sampleRate);
    for (let a = 0; a < n; a += per) {
      if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const b = Math.min(n, a + per);
      const pre = Math.max(0, a - 2); // two frames of pre-roll so the first real frame decodes cleanly
      const blob = muxFrames(d, pre, b);
      const buf = await decodeAB(ctx, await blob.arrayBuffer());
      if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      // Keep exactly the samples of frames [a, b), aligned to the end (drops pre-roll and priming).
      const want = Math.round((d.starts[b] - d.starts[a]) * buf.sampleRate);
      const chans = [];
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const src = buf.getChannelData(c);
        const out = new Float32Array(want);
        const take = Math.min(want, src.length);
        out.set(src.subarray(src.length - take), want - take);
        chans.push(out);
      }
      onPcm(chans, want, buf.sampleRate);
      onProgress && onProgress(b / n);
      await new Promise((r) => setTimeout(r, 0));
    }
    return true;
  }
  // decodeAudioData, also for older Safari that only supports the callback form.
  function decodeAB(ctx, ab) {
    return new Promise((res, rej) => {
      const pr = ctx.decodeAudioData(ab, res, rej);
      if (pr && pr.then) pr.then(res, rej);
    });
  }

  // ---------- PCM fallback (MP3, WAV, ALAC, odd M4A) ----------

  async function decodeWhole(arrayBuffer) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    try {
      return await ctx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
      ctx.close && ctx.close();
    }
  }

  function wavBlob(buffer, from, to) {
    const ch = buffer.numberOfChannels, sr = buffer.sampleRate, n = to - from;
    const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
    out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
    w(36, 'data'); out.setUint32(40, n * ch * 2, true);
    const data = [];
    for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
    let o = 44;
    for (let i = from; i < to; i++) {
      for (let c = 0; c < ch; c++) {
        const v = Math.max(-1, Math.min(1, data[c][i]));
        out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([out.buffer], { type: 'audio/wav' });
  }

  const AAC_CFG = (sr, ch) => ({ codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: ch, bitrate: ch > 1 ? 160000 : 96000 });

  async function canEncodeAac(sr, ch) {
    if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return false;
    try {
      return (await AudioEncoder.isConfigSupported(AAC_CFG(sr, ch))).supported;
    } catch (e) {
      return false;
    }
  }

  // Re-encode samples [from, to) of an AudioBuffer to AAC in M4A.
  async function aacBlob(buffer, from, to) {
    const ch = buffer.numberOfChannels, sr = buffer.sampleRate;
    const target = new Mp4Muxer.ArrayBufferTarget();
    const muxer = new Mp4Muxer.Muxer({
      target,
      audio: { codec: 'aac', numberOfChannels: ch, sampleRate: sr },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    let error = null;
    const enc = new AudioEncoder({ output: (chunk, m) => muxer.addAudioChunk(chunk, m), error: (e) => { error = e; } });
    enc.configure(AAC_CFG(sr, ch));
    const block = 8192;
    for (let i = from; i < to; i += block) {
      const n = Math.min(block, to - i);
      const planar = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) planar.set(buffer.getChannelData(c).subarray(i, i + n), c * n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round(((i - from) / sr) * 1e6), data: planar });
      enc.encode(ad);
      ad.close();
      if (error) throw error;
    }
    await enc.flush();
    enc.close();
    if (error) throw error;
    muxer.finalize();
    return new Blob([target.buffer], { type: 'audio/mp4' });
  }

  window.M4A = { demux, muxFrames, frameBytes, frameAt, decodeStream, decodeChunked, decodeWhole, wavBlob, aacBlob, canEncodeAac };
})();
