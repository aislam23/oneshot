// oneshot · MIT © 2026 Artem Islamov
// gallery — словарь движений: лист кадров галереи (gallery/moves.png) и таблица замеров (docs/moves.md).
//   oneshot gallery
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openComp, run, log, runtime } from './util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function gallery() {
  const OS = runtime(), P = OS.phys;
  const rows = [
    ['пружина «щелчок»', 'F.punch, перебор, нажатия', t => P.spring(t, 3.2, 0.35), 1.2],
    ['пружина «живая»', 'F.anticipate, появления', t => P.spring(t, 2.4, 0.5), 1.2],
    ['пружина «мягкая»', 'большие переезды предметов', t => P.spring(t, 1.4, 0.8), 1.6],
    ['догонялка', 'F.follow (f 1.6, d 0.55)', t => P.spring(t, 1.6, 0.55), 1.8],
    ['камера whip', 'переброс камеры', u => OS.operEase('whip')(u), 1],
    ['камера chase', 'камера догоняет объект', u => OS.operEase('chase')(u), 1],
    ['камера glide', 'плавный наезд/отъезд', u => OS.operEase('glide')(u), 1],
  ];
  const md = ['# Словарь движений oneshot', '',
    'Замеры кривых, на которых построены движения. **Резкость** — доля времени до 80 % пути (0,1 — щелчок, 0,5 — плавно).',
    '**Перелёт** — насколько уходит дальше цели. **Успокоение** — когда отклонение меньше 2 %. Обновить: `oneshot gallery`.', '',
    'Живая галерея: `gallery/index.html?play` (откройте в браузере), лист кадров: `gallery/moves.png`.', '',
    '| кривая | где используется | резкость | перелёт | успокоение |', '|---|---|---:|---:|---:|'];
  for (const [name, use, fn, dur] of rows) { const m = P.measure(fn, dur); md.push(`| ${name} | ${use} | ${m.sharpness} | ${m.overshoot} % | ${dur === 1 ? Math.round(m.settle * 100) + ' % отрезка' : m.settle + ' с'} |`); }
  const d = P.drop(0, 640, 5200, 0.32);
  md.push('', `**F.drop** (высота 640 px): касания на ${d.hits.map(h => h.t.toFixed(2) + ' с').join(', ')}; скорость удара ${d.hits.map(h => Math.round(h.v)).join(' → ')} px/с; сплющивание ∝ скорости.`);
  md.push('', '## Как выбирать', '',
    '| задача | движение | почему |', '|---|---|---|',
    '| предмет приходит в кадр сверху | `F.drop` | вес: ускорение, удар, отскок, сплющивание |',
    '| удар должен «отозваться» в сцене | `F.land(t, соседи, { at })` | волна от точки удара: соседи подпрыгивают по очереди |',
    '| предмет перелетает в новое место | `F.throw` | дуга и вращение читаются как бросок, а не как сдвиг |',
    '| резкий старт после паузы | `F.anticipate` | замах назад делает рывок заметным |',
    '| после нажатия или приземления | `F.wobble` | вторичное движение: предмет «живой» |',
    '| акцент на слове | `F.punch` | короткий удар масштабом с перелётом |',
    '| предмет тянется за другим | `F.follow` | запаздывание и перелёт — как у живого |',
    '| камера перебрасывается | ключ `move: \'whip\'` | быстрый старт, небольшой перелёт, успокоение |',
    '| камера ведёт объект | ключ `move: \'chase\'` | отстаёт и догоняет с перелётом |',
    '| камера плавно наезжает | ключ `move: \'glide\'` | без перелёта |', '',
    'Правило: один и тот же жест — не больше 3–4 раз за ролик. Физичные движения складываются: `F.drop` + `F.wobble` + `F.land` на одном ударе — это и есть «отклик».');
  writeFileSync(join(ROOT, 'docs/moves.md'), md.join('\n') + '\n');
  // лист кадров
  const tmp = join(ROOT, 'gallery/.frames'); rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
  const browser = await launch(); const { page, errors } = await openComp(browser, join(ROOT, 'gallery/index.html'));
  const times = [0.2, 0.55, 0.75, 1.0, 1.4, 2.4];
  for (const [i, t] of times.entries()) { await page.evaluate(x => window.oneshot.seek(x), t); await page.screenshot({ path: join(tmp, `${i}.png`) }); }
  await browser.close();
  await run('ffmpeg', ['-y', '-v', 'error', '-framerate', '1', '-i', join(tmp, '%d.png'), '-vf', 'scale=960:-1,tile=2x3:padding=6:color=white', '-frames:v', '1', join(ROOT, 'gallery/moves.png')]);
  rmSync(tmp, { recursive: true, force: true });
  log(`gallery: docs/moves.md, gallery/moves.png${errors.length ? ' · ошибки: ' + errors.join(' | ') : ''}`);
}
