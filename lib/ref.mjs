// oneshot · MIT © 2026 Artem Islamov
// ref — разбор референса в цифрах: сколько в нём покоя, где склейки и сериями ли они идут, какой длины планы,
// где пики движения. Это цели для своего ролика, а не «на глаз».
//   oneshot ref reference.mp4 [--json ref.json]
import { writeFileSync } from 'node:fs';
import { run, log } from './util.mjs';

export async function ref(file, o) {
  const dur = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).then(r => +r.out.trim());
  const fps = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file]).then(r => { const [a, b] = r.out.trim().split('/'); return +a / (+b || 1); });
  // движение кадра: средняя разница соседних кадров (0…255)
  const { err } = await run('ffmpeg', ['-v', 'info', '-i', file, '-vf', 'scale=192:108,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-an', '-f', 'null', '-']).catch(e => ({ err: String(e) }));
  const E = [...err.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map(m => +m[1]);
  // склейки: резкая смена сцены
  const sc = await run('ffmpeg', ['-v', 'info', '-i', file, '-vf', "select='gt(scene,0.32)',showinfo", '-an', '-f', 'null', '-']).catch(e => ({ err: String(e) }));
  const cuts = [...(sc.err || '').matchAll(/pts_time:([\d.]+)/g)].map(m => +m[1]);
  const still = E.filter(v => v < 0.35).length / Math.max(1, E.length);
  let best = 0, cur = 0; for (const v of E) { cur = v < 0.35 ? cur + 1 : 0; best = Math.max(best, cur); }
  const shots = [0, ...cuts, dur].map((t, i, a) => (i ? t - a[i - 1] : null)).filter(x => x !== null && x > 0.05);
  const m = shots.reduce((a, b) => a + b, 0) / shots.length, cv = Math.sqrt(shots.reduce((a, b) => a + (b - m) ** 2, 0) / shots.length) / m;
  const bursts = []; for (let i = 0; i < cuts.length; i++) { let j = i; while (j + 1 < cuts.length && cuts[j + 1] - cuts[i] < 1.5) j++; if (j - i >= 2) { bursts.push([cuts[i], cuts[j], j - i + 1]); i = j; } }
  // карта энергии: строка на каждые 2 с, по символу на 0,25 с
  const per = Math.max(1, Math.round(fps / 4)), sym = ' .:-=+*#%@', mx = Math.max(...E, 1), rows = [];
  for (let s = 0; s < dur; s += 2) { let line = ''; for (let q = 0; q < 8; q++) { const a = Math.round((s + q * 0.25) * fps), seg = E.slice(a, a + per); const v = seg.length ? seg.reduce((x, y) => x + y, 0) / seg.length : 0; line += sym[Math.min(9, Math.floor(Math.sqrt(v / mx) * 9.99))]; } rows.push(`${s.toFixed(0).padStart(4)} с |${line}|`); }
  log(rows.join('\n'));
  const out = { duration: +dur.toFixed(2), fps, stillShare: +still.toFixed(3), longestRest: +(best / fps).toFixed(2), cuts: cuts.map(c => +c.toFixed(2)), bursts, shotMean: +m.toFixed(2), shotCV: +cv.toFixed(2), shortest: +Math.min(...shots).toFixed(2), longest: +Math.max(...shots).toFixed(2) };
  log(`\nдлина ${out.duration} с · покой ${(still * 100).toFixed(0)} % кадров · самая длинная пауза ${out.longestRest} с`);
  log(`склеек ${cuts.length}${bursts.length ? `, сериями: ${bursts.map(b => `${b[2]} за ${(b[1] - b[0]).toFixed(1)} с на ${b[0].toFixed(1)}`).join('; ')}` : ''}`);
  log(`планы: в среднем ${out.shotMean} с, разброс ${out.shotCV}, от ${out.shortest} до ${out.longest} с`);
  log(`\nцели для своего ролика: покой ${Math.round(still * 100 - 5)}–${Math.round(still * 100 + 5)} %, пауза не короче ${Math.max(0.8, out.longestRest * 0.7).toFixed(1)} с` +
    (bursts.length ? `, удары сериями по ${bursts[0][2]}` : cuts.length ? '' : ', без склеек — непрерывное движение'));
  if (o.json) writeFileSync(o.json, JSON.stringify(out, null, 2));
  return out;
}
