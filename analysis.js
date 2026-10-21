/* Loudness envelope, ITU-R BS.1770 LUFS and quiet-point search for Smart Split. */
(function () {
  'use strict';

  // K-weighting filter (two biquads) for any sample rate, as in BS.1770 / libebur128.
  function kCoeffs(fs) {
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan((Math.PI * f0) / fs);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const s1 = {
      b0: (Vh + (Vb * K) / Q + K * K) / a0,
      b1: (2 * (K * K - Vh)) / a0,
      b2: (Vh - (Vb * K) / Q + K * K) / a0,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
    f0 = 38.13547087602444; Q = 0.5003270373238773;
    K = Math.tan((Math.PI * f0) / fs);
    a0 = 1 + K / Q + K * K;
    const s2 = { a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
    return [s1, s2];
  }

  // Feed PCM blocks in order; collects a 10 ms mean-square envelope and 100 ms K-weighted energies.
  class Analyzer {
    push(chans, len, sr) {
      if (!this.sr) this.init(sr, chans.length);
      if (!this.raw || this.raw.length < len) {
        this.raw = new Float64Array(len);
        this.kb = new Float64Array(len);
      }
      const raw = this.raw, kb = this.kb;
      raw.fill(0, 0, len);
      kb.fill(0, 0, len);
      const [s1, s2] = this.k;
      const { b0, b1, b2, a1, a2 } = s1, c1 = s2.a1, c2 = s2.a2;
      const nch = Math.min(chans.length, this.st.length);
      for (let c = 0; c < nch; c++) {
        const x = chans[c], st = this.st[c];
        let x1 = st[0], x2 = st[1], y1 = st[2], y2 = st[3], z1 = st[4], z2 = st[5];
        for (let i = 0; i < len; i++) {
          const xi = x[i];
          raw[i] += xi * xi;
          const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
          const z = y - 2 * y1 + y2 - c1 * z1 - c2 * z2;
          x2 = x1; x1 = xi; y2 = y1; y1 = y; z2 = z1; z1 = z;
          kb[i] += z * z;
        }
        st[0] = x1; st[1] = x2; st[2] = y1; st[3] = y2; st[4] = z1; st[5] = z2;
      }
      const inv = 1 / nch;
      for (let i = 0; i < len; i++) {
        this.a10 += raw[i] * inv;
        if (++this.n10 === this.hop10) { this.env.push(this.a10 / this.hop10); this.a10 = 0; this.n10 = 0; }
        this.a100 += kb[i];
        if (++this.n100 === this.hop100) { this.kms.push(this.a100 / this.hop100); this.a100 = 0; this.n100 = 0; }
      }
      this.total += len;
    }
    init(sr, ch) {
      this.sr = sr;
      this.hop10 = Math.round(sr / 100);
      this.hop100 = this.hop10 * 10;
      this.k = kCoeffs(sr);
      this.st = [];
      for (let c = 0; c < ch; c++) this.st.push(new Float64Array(6));
      this.env = []; this.kms = [];
      this.a10 = 0; this.n10 = 0; this.a100 = 0; this.n100 = 0; this.total = 0;
    }
    finish() {
      if (!this.sr) return null;
      const env = Float32Array.from(this.env);
      const prefix = new Float64Array(env.length + 1);
      for (let i = 0; i < env.length; i++) prefix[i + 1] = prefix[i] + env[i];
      // Noise floor = 10th percentile of the envelope in dB.
      const sorted = Float32Array.from(env).sort();
      const floorMs = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : 0;
      const medMs = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 0;
      return {
        sr: this.sr,
        step: this.hop10 / this.sr,
        kStep: this.hop100 / this.sr,
        env, prefix,
        kms: Float32Array.from(this.kms),
        floorDb: 10 * Math.log10(floorMs + 1e-12),
        medianDb: 10 * Math.log10(medMs + 1e-12),
        duration: this.total / this.sr,
      };
    }
  }

  // Analyse a whole AudioBuffer (fallback path) in blocks.
  function analyzeBuffer(buffer) {
    const a = new Analyzer();
    const block = 65536, ch = buffer.numberOfChannels, data = [];
    for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
    for (let i = 0; i < buffer.length; i += block) {
      const n = Math.min(block, buffer.length - i);
      a.push(data.map((d) => d.subarray(i, i + n)), n, buffer.sampleRate);
    }
    return a.finish();
  }

  const L = (e) => -0.691 + 10 * Math.log10(e);

  // Integrated loudness (LUFS) of [a, b] seconds: 400 ms blocks, 75 % overlap, -70 / -10 gates.
  function lufs(an, a, b) {
    if (!an) return null;
    const k = an.kms;
    const j0 = Math.max(0, Math.ceil(a / an.kStep - 1e-6));
    const j1 = Math.min(k.length - 4, Math.floor(b / an.kStep + 1e-6) - 4);
    const blocks = [];
    for (let j = j0; j <= j1; j++) {
      const e = (k[j] + k[j + 1] + k[j + 2] + k[j + 3]) / 4;
      if (e > 0 && L(e) > -70) blocks.push(e);
    }
    if (!blocks.length) return null;
    let sum = 0;
    for (const e of blocks) sum += e;
    const rel = L(sum / blocks.length) - 10;
    let s2 = 0, n2 = 0;
    for (const e of blocks) if (L(e) > rel) { s2 += e; n2++; }
    return n2 ? L(s2 / n2) : null;
  }

  // Quietest point in [lo, hi] seconds, with a mild pull toward target t.
  // Uses a 250 ms moving average so a single quiet sample does not count as a pause.
  function quietest(an, t, lo, hi) {
    const n = an.env.length, step = an.step, P = an.prefix, half = Math.max(2, Math.round(0.12 / step));
    const i0 = Math.max(0, Math.floor(lo / step)), i1 = Math.min(n - 1, Math.ceil(hi / step));
    const span = Math.max(step, (hi - lo) / 2);
    let best = -1, bestScore = Infinity, bestDb = 0;
    for (let i = i0; i <= i1; i++) {
      const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
      const db = 10 * Math.log10((P[b] - P[a]) / (b - a) + 1e-12);
      const score = db + (3 * Math.abs(i * step - t)) / span;
      if (score < bestScore) { bestScore = score; best = i; bestDb = db; }
    }
    if (best < 0) return { time: t, db: 0, isPause: false };
    return { time: best * step, db: bestDb, isPause: bestDb < an.floorDb + 8 && bestDb < an.medianDb - 12 };
  }

  window.Analysis = { Analyzer, analyzeBuffer, lufs, quietest };
})();
