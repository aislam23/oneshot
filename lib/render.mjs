// oneshot · MIT © 2026 Artem Islamov
// render — композиция → mp4. Каждый кадр: K скриншотов внутри открытого «затвора», ffmpeg усредняет их (tmix),
// и быстрые движения размываются, как у настоящей камеры. Неподвижный кадр снимается дважды и повторяется.
// Несколько браузеров работают параллельно, каждый пишет свой кусок; куски склеиваются без перекодирования.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import os from 'node:os';
import { launch, openComp, run, log, num } from './util.mjs';

export async function render(comp, o) {
  const final = !!o.final;
  const scale = num(o.scale, final ? 2 : 1);
  const blur = num(o.blur, final ? 8 : 5);              // подкадров на кадр; 0 или 1 — без размытия
  const shutter = num(o.shutter, 0.5);                  // доля кадра, пока «затвор открыт» (0.5 = 180°)
  const workers = Math.max(1, num(o.workers, Math.min(8, Math.max(1, os.cpus().length - 2))));
  const crf = num(o.crf, final ? 14 : 18);
  const out = resolve(o.out || (final ? 'final.mp4' : 'draft.mp4'));

  const b0 = await launch(); const probe = await openComp(b0, comp); await b0.close();
  const meta = probe.meta;
  const fps = num(o.fps, final ? 60 : meta.fps || 30);
  const t0 = num(o.from, 0), t1 = num(o.to, meta.duration);
  const N = Math.round((t1 - t0) * fps), K = Math.max(1, Math.round(blur)), sh = shutter / fps;
  const tmp = join(dirname(out), '.oneshot-' + basename(out, '.mp4')); rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });

  log(`render ${N} кадров ${meta.width * scale}×${meta.height * scale} @${fps} · размытие ${K > 1 ? K + ' подкадров' : 'выкл'} · ${workers} потоков`);
  const started = Date.now(); let done = 0, captures = 0, still = 0;
  const tick = setInterval(() => log(`  ${done}/${N}  ${Math.round((Date.now() - started) / 1000)} с`), 10000);

  const per = Math.ceil(N / workers), parts = [];
  const jobs = [];
  for (let w = 0; w < workers; w++) {
    const a = w * per, b = Math.min(N, a + per); if (a >= b) break;
    const part = join(tmp, `part-${String(w).padStart(2, '0')}.mp4`); parts.push(part);
    jobs.push(chunk(a, b, part));
  }

  async function chunk(a, b, part) {
    const browser = await launch(); const { page, errors } = await openComp(browser, comp, { scale });
    const vf = [];
    if (K > 1) vf.push(`tmix=frames=${K}`, `select=not(mod(n+1\\,${K}))`);
    vf.push(`setpts=N/(${fps}*TB)`);
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps * K), '-i', '-',
      '-vf', vf.join(','), '-r', String(fps), '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', part], { stdio: ['pipe', 'ignore', 'pipe'] });
    let ffErr = ''; ff.stderr.on('data', d => (ffErr += d));
    const closed = new Promise((ok, fail) => ff.on('close', c => (c === 0 ? ok() : fail(new Error('ffmpeg: ' + ffErr)))));
    const write = buf => new Promise(ok => (ff.stdin.write(buf) ? ok() : ff.stdin.once('drain', ok)));
    const shot = async t => { await page.evaluate(x => window.oneshot.seek(x), t); captures++; return page.screenshot({ type: 'jpeg', quality: 94 }); };
    for (let f = a; f < b; f++) {
      const tf = t0 + f / fps;
      if (K === 1) { await write(await shot(tf)); done++; continue; }
      const ts = [];
      for (let j = 0; j < K; j++) {
        let t = tf + (j / (K - 1) - 0.5) * sh;
        for (const c of meta.cuts) { if (c > tf && t >= c) t = tf; if (c <= tf && t < c) t = tf; }   // затвор не открыт через склейку
        ts.push(Math.min(Math.max(t, 0), meta.duration - 1e-4));
      }
      const first = await shot(ts[0]), last = await shot(ts[K - 1]);
      if (first.equals(last)) { still++; for (let j = 0; j < K; j++) await write(first); }
      else {
        const bufs = [first]; for (let j = 1; j < K - 1; j++) bufs.push(await shot(ts[j])); bufs.push(last);
        for (const x of bufs) await write(x);
      }
      done++;
    }
    ff.stdin.end(); await closed; await browser.close();
    if (errors.length) log('  ошибки страницы:', errors.slice(0, 3).join(' | '));
  }

  await Promise.all(jobs); clearInterval(tick);
  const list = join(tmp, 'list.txt'); writeFileSync(list, parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  const video = join(tmp, 'video.mp4');
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video]);
  if (o.audio && existsSync(o.audio)) {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-ss', String(t0), '-i', o.audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(t1 - t0), out]);
  } else renameSync(video, out);
  const secs = Math.round((Date.now() - started) / 1000);
  const rec = { out, frames: N, fps, scale, blur: K, shutter, workers, captures, stillFrames: still, seconds: secs, from: t0, to: t1 };
  writeFileSync(out.replace(/\.mp4$/, '') + '.render.json', JSON.stringify(rec, null, 2));
  rmSync(tmp, { recursive: true, force: true });
  log(`готово: ${out} · ${captures} снимков, ${still} неподвижных кадров, ${secs} с`);
  return rec;
}
