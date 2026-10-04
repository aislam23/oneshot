// oneshot · MIT © 2026 Artem Islamov
// vo — партитура от голоса. Текст диктора → тайминг каждой фразы и слова → vo/plan.js, субтитры, черновой голос, волна.
//
//   oneshot vo plan  vo/lines.txt [--say vo/say.txt] [--voice Milena] [--rate 175] [--speed 0.9] [--lead 0.5] [--gap 0.36] [--duration 90]
//   oneshot vo audio vo/lines.txt voice.mp3        — тайминг по готовой озвучке (ElevenLabs и т. п.)
//
// lines.txt: одна фраза диктора на строку. «|» внутри фразы делит субтитр на две карточки.
// Пустая строка между фразами — пауза подлиннее (+0.5 с). Строки с # — комментарии.
// say.txt (необязательно): те же фразы, записанные «как слышится» (Клод Код, эйч-ти-эм-эль) — для черновой озвучки.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';
import { run, has, log, die, num } from './util.mjs';

const PUNCT = /[,.:;!?—–«»"()…]/;
const weight = s => [...s].reduce((a, c) => a + (PUNCT.test(c) ? 3 : c === ' ' ? 1.2 : 1), 0);

export function readLines(file) {
  const raw = readFileSync(file, 'utf8').split(/\r?\n/);
  const lines = []; let extra = 0;
  for (const r of raw) {
    const s = r.trim();
    if (s.startsWith('#')) continue;
    if (!s) { if (lines.length) extra += 0.5; continue; }
    lines.push({ text: s, pauseBefore: extra }); extra = 0;
  }
  return lines;
}

// слова фразы с оценкой времени: пропорционально «весу» символов, знаки препинания — это паузы
function words(text, start, end) {
  const clean = text.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
  const total = weight(clean), out = []; let acc = 0;
  for (const w of clean.split(' ')) { out.push({ w: w.replace(/[^\p{L}\p{N}\-./~]/gu, ''), t: +(start + (end - start) * acc / total).toFixed(3) }); acc += weight(w + ' '); }
  return out;
}

async function pcmBuf(file) {
  return new Promise((ok, fail) => {
    import('node:child_process').then(({ spawn }) => {
      const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-']); const chunks = [];
      p.stdout.on('data', d => chunks.push(d)); p.on('close', c => (c === 0 ? ok((b => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)))(Buffer.concat(chunks))) : fail(new Error('ffmpeg pcm ' + file))));
    });
  });
}
// границы речи в клипе (порог −42 дБ)
function speechBounds(a, sr = 16000) {
  const thr = Math.pow(10, -42 / 20); let i0 = 0, i1 = a.length - 1;
  while (i0 < a.length && Math.abs(a[i0]) < thr) i0++;
  while (i1 > i0 && Math.abs(a[i1]) < thr) i1--;
  return [i0 / sr, i1 / sr];
}
// огибающая громкости 25 раз в секунду, 0…1
function envelope(a, dur, sr = 16000, rate = 25) {
  const n = Math.ceil(dur * rate), hop = sr / rate, env = new Array(n).fill(0);
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let j = Math.floor(i * hop); j < Math.min(a.length, (i + 1) * hop); j++) { s += a[j] * a[j]; c++; } env[i] = c ? Math.sqrt(s / c) : 0; }
  const mx = Math.max(...env, 1e-6); return env.map(v => +(Math.min(1, v / mx * 1.15)).toFixed(3));
}
function srtTime(x) { const h = Math.floor(x / 3600), m = Math.floor(x % 3600 / 60), s = x % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')},${String(Math.round((s % 1) * 1000)).padStart(3, '0')}`; }
function cues(lines) {
  const out = [];
  for (const l of lines) {
    const parts = l.text.split('|').map(s => s.trim()).filter(Boolean); const tot = parts.reduce((a, p) => a + weight(p), 0); let acc = 0;
    for (const p of parts) { const a = l.start + (l.end - l.start) * acc / tot; acc += weight(p); const b = l.start + (l.end - l.start) * acc / tot; out.push({ a, b: Math.max(b, a + 0.9), text: p }); }
  }
  return out;
}

function writeOutputs(dir, lines, total, env, source) {
  mkdirSync(dir, { recursive: true });
  const plan = { source, total: +total.toFixed(3), lines: lines.map((l, i) => ({ i: i + 1, text: l.text.replace(/\|/g, ' '), start: +l.start.toFixed(3), end: +l.end.toFixed(3), words: words(l.text, l.start, l.end) })), env, envRate: 25 };
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 1));
  writeFileSync(join(dir, 'plan.js'), '// создано `oneshot vo` — не править руками\nwindow.VO = ' + JSON.stringify(plan) + ';\n');
  const C = cues(plan.lines.map((l, i) => ({ ...l, text: lines[i].text })));
  writeFileSync(join(dir, 'subtitles.srt'), C.map((c, i) => `${i + 1}\n${srtTime(c.a)} --> ${srtTime(c.b)}\n${c.text}\n`).join('\n'));
  const table = ['| Начало | Конец | Текст |', '|---:|---:|---|', ...C.map(c => `| ${c.a.toFixed(2)} | ${c.b.toFixed(2)} | ${c.text} |`)].join('\n');
  writeFileSync(join(dir, 'subtitles.md'), table + '\n');
  log(`vo: ${lines.length} фраз, речь до ${lines[lines.length - 1].end.toFixed(2)} с → ${join(dir, 'plan.js')}, subtitles.srt`);
  for (const l of plan.lines) log(`  ${String(l.i).padStart(2)}  ${l.start.toFixed(2).padStart(6)}–${l.end.toFixed(2).padEnd(6)} ${l.text}`);
}

export async function plan(file, o) {
  const lines = readLines(file); if (!lines.length) die('в ' + file + ' нет фраз');
  const sayLines = o.say && existsSync(o.say) ? readLines(o.say).map(l => l.text) : null;
  if (sayLines && sayLines.length !== lines.length) die(`в ${o.say} ${sayLines.length} строк, а фраз ${lines.length}`);
  const dir = dirname(resolve(file)), lead = num(o.lead, 0.5), gap = num(o.gap, 0.36);
  const canSay = has('say') && !o.noSay; const voice = o.voice || 'Milena', rate = num(o.rate, 175);
  const tmp = join(os.tmpdir(), 'oneshot-vo-' + process.pid); mkdirSync(tmp, { recursive: true });
  const clips = [];
  for (let i = 0; i < lines.length; i++) {
    const spoken = (sayLines ? sayLines[i] : lines[i].text).replace(/\|/g, ' ');
    if (canSay) {
      const f = join(tmp, `l${i}.aiff`); await run('say', ['-v', voice, '-r', String(rate), '-o', f, spoken]);
      let src = f; const sp = num(o.speed, 1);
      if (sp !== 1) { src = join(tmp, `l${i}.wav`); await run('ffmpeg', ['-y', '-v', 'error', '-i', f, '-filter:a', `atempo=${sp}`, src]); }   // темп диктора: 0.9 — медленнее на 10 %
      const a = await pcmBuf(src); const [s, e] = speechBounds(a); clips.push({ a: a.subarray(Math.floor(s * 16000), Math.ceil(e * 16000) + 1600), dur: e - s + 0.1 });
    } else clips.push({ a: null, dur: spoken.length / 14.5 });   // без say: ~14,5 символа в секунду
  }
  let t = lead;
  lines.forEach((l, i) => { t += l.pauseBefore; l.start = t; l.end = t + clips[i].dur; t = l.end + gap; });
  const total = num(o.duration, Math.ceil(lines[lines.length - 1].end + 2));
  let env = [];
  if (canSay) {
    const mix = new Float32Array(Math.ceil(total * 16000));
    lines.forEach((l, i) => mix.set(clips[i].a.subarray(0, Math.max(0, mix.length - Math.floor(l.start * 16000))), Math.floor(l.start * 16000)));
    env = envelope(mix, total);
    const raw = join(tmp, 'guide.f32'); writeFileSync(raw, Buffer.from(mix.buffer));
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'f32le', '-ar', '16000', '-ac', '1', '-i', raw, '-ar', '48000', join(dir, 'guide.wav')]);
    log('vo: черновой голос → ' + join(dir, 'guide.wav') + ` (${voice}, ${rate} слов/мин)`);
  } else log('vo: команды say нет — тайминг оценён по длине текста (14,5 символа/с), чернового голоса не будет');
  rmSync(tmp, { recursive: true, force: true });
  writeOutputs(dir, lines, total, env, canSay ? `say:${voice}@${rate}` : 'estimate');
}

// тайминг по настоящей озвучке: ищем паузы, самые длинные из них — границы фраз
export async function fromAudio(file, audio, o) {
  const lines = readLines(file); const a = await pcmBuf(audio); const sr = 16000, dur = a.length / sr;
  const hop = 160, thr = Math.pow(10, num(o.threshold, -38) / 20); const voiced = [];
  for (let i = 0; i < a.length; i += hop) { let m = 0; for (let j = i; j < Math.min(a.length, i + hop); j++) m = Math.max(m, Math.abs(a[j])); voiced.push(m > thr); }
  const segs = []; let s = -1;   // отрезки речи (10 мс шаг), склеиваем разрывы короче 80 мс
  voiced.forEach((v, i) => { if (v && s < 0) s = i; if (!v && s >= 0) { segs.push([s, i]); s = -1; } }); if (s >= 0) segs.push([s, voiced.length]);
  const merged = []; for (const g of segs) { if (merged.length && g[0] - merged[merged.length - 1][1] < 8) merged[merged.length - 1][1] = g[1]; else merged.push([...g]); }
  if (merged.length < lines.length) die(`в озвучке нашлось ${merged.length} кусков речи, а фраз ${lines.length}. Сделайте паузы между фразами длиннее (в ElevenLabs — перенос строки или [short pause]) или понизьте --threshold`);
  const gaps = merged.slice(1).map((g, i) => ({ i, len: g[0] - merged[i][1] })).sort((x, y) => y.len - x.len).slice(0, lines.length - 1).map(x => x.i).sort((x, y) => x - y);
  let from = 0; const bounds = [];
  for (const gi of [...gaps, merged.length - 1]) { bounds.push([merged[from][0] * hop / sr, merged[gi][1] * hop / sr]); from = gi + 1; }
  lines.forEach((l, i) => { l.start = bounds[i][0]; l.end = bounds[i][1]; });
  // проверка здравого смысла: длительности должны идти примерно как длина текста
  const ratio = lines.map(l => (l.end - l.start) / weight(l.text)); const med = ratio.slice().sort((x, y) => x - y)[Math.floor(ratio.length / 2)];
  lines.forEach((l, i) => { if (ratio[i] > med * 2.2 || ratio[i] < med / 2.2) log(`  внимание: фраза ${i + 1} звучит ${(l.end - l.start).toFixed(1)} с — проверьте, правильно ли нашлась граница`); });
  const total = num(o.duration, Math.ceil(Math.max(dur, lines[lines.length - 1].end + 1.5)));
  writeOutputs(dirname(resolve(file)), lines, total, envelope(a, total), 'audio:' + audio);
}
