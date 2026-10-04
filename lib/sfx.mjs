// oneshot · MIT © 2026 Artem Islamov
// sfx — звуки из событий композиции (F.sound). Небольшой синтезатор на чистом JS: все звуки из одного «материала»
// и в одной комнате (общая реверберация), поэтому они не спорят друг с другом и с голосом.
//   oneshot sfx comp.html [--out sfx.wav] [--peak -14]
//   oneshot mix --voice voice.mp3 [--sfx sfx.wav] [--music music.mp3] --out mix.wav   — голос + звуки + музыка под голосом
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { launch, openComp, run, log, num } from './util.mjs';

const SR = 48000;
let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;   // детерминированный шум

// ── простые фильтры ──
function biquad(x, type, f, q = 0.8) {
  const w = 2 * Math.PI * Math.min(f, SR / 2 - 100) / SR, al = Math.sin(w) / (2 * q), c = Math.cos(w); let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; } else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; } else { b0 = al; b1 = 0; b2 = -al; }
  a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
// полосовой фильтр, центр которого едет от f0 к f1 (для «вжуха»)
function sweep(x, f0, f1, q) {
  const y = new Float32Array(x.length), blk = 512;
  for (let s = 0; s < x.length; s += blk) {
    const k = s / x.length, f = f0 * Math.pow(f1 / f0, k); const pre = Math.max(0, s - 1024);
    const part = biquad(x.subarray(pre, Math.min(x.length, s + blk)), 'bp', f, q); y.set(part.subarray(s - pre), s);
  }
  return y;
}
const buf = sec => new Float32Array(Math.max(1, Math.round(sec * SR)));
const norm = x => { let m = 0; for (const v of x) m = Math.max(m, Math.abs(v)); if (m > 0) for (let i = 0; i < x.length; i++) x[i] /= m; return x; };

// ── материалы ──
const S = {
  whoosh(o = {}) { const d = o.dur ?? 0.55, x = buf(d); for (let i = 0; i < x.length; i++) x[i] = rnd();
    const y = sweep(x, o.f0 ?? 300, o.f1 ?? 2800, 1.3); for (let i = 0; i < y.length; i++) { const u = i / y.length; y[i] *= Math.pow(Math.sin(Math.PI * u), 1.6) * (u < 0.55 ? u / 0.55 : 1); } return norm(biquad(y, 'lp', 6000)); },
  pop(o = {}) { const d = 0.2, x = buf(d), f = o.f ?? 520; let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / SR; ph += 2 * Math.PI * f * (1 + 0.8 * (1 - Math.exp(-t * 32))) / SR; x[i] = Math.sin(ph) * Math.exp(-t * 24); } return x; },
  tick(o = {}) { const d = o.dur ?? 0.7, x = buf(d), f = o.f ?? 880; for (let i = 0; i < x.length; i++) { const t = i / SR; x[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 7) * 0.7 + Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t * 16) * 0.25 + rnd() * Math.exp(-t * 300) * 0.15; } return x; },
  click(o = {}) { const d = 0.08, x = buf(d); for (let i = 0; i < x.length; i++) { const t = i / SR; x[i] = Math.sin(2 * Math.PI * (o.f ?? 230) * t) * Math.exp(-t * 70) * 0.8 + rnd() * Math.exp(-t * 500) * 0.5; } return biquad(x, 'hp', 120); },
  key(o = {}) { const d = 0.06, x = buf(d); for (let i = 0; i < x.length; i++) { const t = i / SR; x[i] = rnd() * Math.exp(-t * 600) * 0.6 + Math.sin(2 * Math.PI * (o.f ?? 190) * t) * Math.exp(-t * 90) * 0.5; } return biquad(x, 'bp', 2400, 0.7); },
  thump(o = {}) { const d = o.dur ?? 0.7, x = buf(d), f = o.f ?? 60; let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / SR; ph += 2 * Math.PI * f * (1 + 2 * Math.exp(-t * 26)) / SR; x[i] = Math.tanh(1.6 * Math.sin(ph) * Math.exp(-t * 5.5)); } return x; },
  rise(o = {}) { const d = o.dur ?? 1.2, x = buf(d); for (let i = 0; i < x.length; i++) x[i] = rnd(); const y = sweep(x, 200, 4200, 2.2); for (let i = 0; i < y.length; i++) { const u = i / y.length; y[i] *= u * u; } return norm(y); },
  chord(o = {}) { const d = o.dur ?? 2.2, x = buf(d), fs = o.notes ?? [523.25, 659.25, 783.99, 1046.5]; for (let i = 0; i < x.length; i++) { const t = i / SR; let v = 0; fs.forEach((f, j) => { const tt = t - j * 0.035; if (tt > 0) v += Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt * 2.4) * (1 + 0.3 * Math.sin(2 * Math.PI * f * 2 * tt)); }); x[i] = v / fs.length; } return x; },
  swell(o = {}) { const d = o.dur ?? 1.6, x = buf(d), f = o.f ?? 220; for (let i = 0; i < x.length; i++) { const t = i / SR, u = t / d; x[i] = (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.5 * t) + 0.3 * Math.sin(2 * Math.PI * f * 2 * t)) * Math.sin(Math.PI * u) ** 2 / 1.8; } return biquad(x, 'lp', 1800); },
};
const LEVEL = { whoosh: 0.35, pop: 0.22, tick: 0.14, click: 0.3, key: 0.08, thump: 0.3, rise: 0.18, chord: 0.16, swell: 0.12 };
const SEND = { whoosh: 0.35, pop: 0.3, tick: 0.5, click: 0.15, key: 0.1, thump: 0.3, rise: 0.4, chord: 0.6, swell: 0.6 };

// комната: несколько гребенчатых фильтров + всепропускающие (схема Шрёдера)
function room(x, decay = 1.1) {
  const combs = [1557, 1617, 1491, 1422].map(n => Math.round(n * SR / 44100)), y = new Float32Array(x.length);
  for (const d of combs) { const g = Math.pow(10, -3 * d / SR / decay); const b = new Float32Array(d); let p = 0; let lp = 0;
    for (let i = 0; i < x.length; i++) { const o = b[p]; lp = o * 0.7 + lp * 0.3; b[p] = x[i] + lp * g; p = (p + 1) % d; y[i] += o / combs.length; } }
  let z = y; for (const [d, g] of [[225, 0.7], [556, 0.7], [441, 0.7]]) { const b = new Float32Array(d), out = new Float32Array(z.length); let p = 0;
    for (let i = 0; i < z.length; i++) { const bo = b[p], v = -g * z[i] + bo; b[p] = z[i] + g * v; out[i] = v; p = (p + 1) % d; } z = out; }
  return z;
}

function writeWav(path, L, R) {
  const n = L.length, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4); b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4); }
  writeFileSync(path, b);
}

export async function sfx(comp, o) {
  const browser = await launch(); const { page, meta } = await openComp(browser, comp); const ev = await page.evaluate(() => window.oneshot.events()); await browser.close();
  const n = Math.ceil(meta.duration * SR), dryL = new Float32Array(n), dryR = new Float32Array(n), wet = new Float32Array(n);
  let used = 0;
  for (const e of ev) {
    const gen = S[e.kind]; if (!gen) { log(`  sfx: неизвестный звук «${e.kind}» на ${e.t} с — пропускаю`); continue; }
    const x = gen(e), g = (LEVEL[e.kind] ?? 0.2) * (e.gain ?? 1), p = e.pan ?? 0, gl = Math.sqrt(0.5 * (1 - p)), gr = Math.sqrt(0.5 * (1 + p)), i0 = Math.round(e.t * SR);
    for (let i = 0; i < x.length && i0 + i < n; i++) { if (i0 + i < 0) continue; const v = x[i] * g; dryL[i0 + i] += v * gl; dryR[i0 + i] += v * gr; wet[i0 + i] += v * (SEND[e.kind] ?? 0.3); }
    used++;
  }
  const rv = room(wet); const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = dryL[i] + rv[i] * 0.55; R[i] = dryR[i] + rv[(i + 240) % n] * 0.55; }
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
  const peak = Math.pow(10, num(o.peak, -14) / 20), k = m > 0 ? peak / m : 0;
  for (let i = 0; i < n; i++) { L[i] *= k; R[i] *= k; }
  const out = resolve(o.out || 'sfx.wav'); writeWav(out, L, R);
  log(`sfx: ${used} звуков → ${out} (пик ${num(o.peak, -14)} дБFS — место для голоса оставлено)`);
}

export async function mix(o) {
  if (!o.voice || !existsSync(o.voice)) throw new Error('нужен --voice файл с озвучкой');
  const ins = ['-i', o.voice]; let f = '[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=1.0[v];'; let mixIn = '[v]', count = 1;
  if (o.sfx && existsSync(o.sfx)) { ins.push('-i', o.sfx); f += `[${count}:a]aresample=48000,volume=${num(o.sfxGain, 1.0)}[s];`; mixIn += '[s]'; count++; }
  if (o.music && existsSync(o.music)) {   // музыка уходит вниз, пока звучит голос
    ins.push('-i', o.music); f += `[${count}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${num(o.musicGain, 0.35)}[m0];[v]asplit=2[v1][vk];[m0][vk]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350[m];`;
    mixIn = mixIn.replace('[v]', '[v1]') + '[m]'; count++;
  }
  f += `${mixIn}amix=inputs=${count}:duration=longest:normalize=0,alimiter=limit=0.89[out]`;
  const out = resolve(o.out || 'mix.wav');
  await run('ffmpeg', ['-y', '-v', 'error', ...ins, '-filter_complex', f, '-map', '[out]', '-ar', '48000', out]);
  log('mix → ' + out);
}
