/* Time formatting and transcript / chapter writers. */
(function () {
  'use strict';

  const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

  // 3725.4 -> "1:02:05" (or "2:05" under an hour)
  function clock(t, forceHours) {
    t = Math.max(0, Math.round(t));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
    return h || forceHours ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  const hms = (t) => (t = Math.round(t), `${pad(t / 3600)}:${pad((t % 3600) / 60)}:${pad(t % 60)}`);
  function stamp(t, sep) {
    const ms = Math.round(t * 1000);
    return `${pad(ms / 3600000)}:${pad((ms % 3600000) / 60000)}:${pad((ms % 60000) / 1000)}${sep}${pad(ms % 1000, 3)}`;
  }

  function srt(segs) {
    return segs.map((s, i) => `${i + 1}\n${stamp(s.start, ',')} --> ${stamp(s.end, ',')}\n${s.text.trim()}\n`).join('\n');
  }
  function vtt(segs) {
    return 'WEBVTT\n\n' + segs.map((s) => `${stamp(s.start, '.')} --> ${stamp(s.end, '.')}\n${s.text.trim()}\n`).join('\n');
  }
  // Plain text: paragraphs break on pauses over 2 s; optional [h:mm:ss] at each paragraph.
  function txt(segs, withTimes) {
    const paras = [];
    let cur = null, lastEnd = -Infinity;
    for (const s of segs) {
      const text = s.text.trim();
      if (!text) continue;
      if (!cur || s.start - lastEnd > 2) {
        cur = { start: s.start, parts: [] };
        paras.push(cur);
      }
      cur.parts.push(text);
      lastEnd = s.end;
    }
    return paras.map((p) => (withTimes ? `[${clock(p.start, true)}] ` : '') + p.parts.join(' ')).join('\n\n') + '\n';
  }

  function chaptersTxt(parts) {
    return parts.map((p, i) => `${hms(p.start)} Part ${i + 1}`).join('\n') + '\n';
  }
  function cue(parts, fileName) {
    const msf = (t) => {
      const f = Math.round(t * 75);
      return `${pad(Math.floor(f / 4500))}:${pad((f / 75) % 60)}:${pad(f % 75)}`;
    };
    let out = `TITLE "${fileName.replace(/"/g, "'")}"\nFILE "${fileName.replace(/"/g, "'")}" WAVE\n`;
    parts.forEach((p, i) => {
      out += `  TRACK ${pad(i + 1)} AUDIO\n    TITLE "Part ${i + 1}"\n    INDEX 01 ${msf(p.start)}\n`;
    });
    return out;
  }
  function chaptersJson(parts) {
    return JSON.stringify(parts.map((p, i) => ({ title: `Part ${i + 1}`, start: +p.start.toFixed(3), end: +p.end.toFixed(3) })), null, 2);
  }

  // WebVTT chapter track (one cue per part), for players that show chapters.
  function chaptersVtt(parts) {
    return 'WEBVTT\n\n' + parts.map((p, i) => `Part ${i + 1}\n${stamp(p.start, '.')} --> ${stamp(p.end, '.')}\nPart ${i + 1}\n`).join('\n');
  }
  const partHeading = (p, i) => `── Part ${i + 1} · ${clock(p.start)}–${clock(p.end)} ──`;

  window.Subs = { clock, hms, srt, vtt, txt, chaptersTxt, cue, chaptersJson, chaptersVtt, partHeading };
})();
