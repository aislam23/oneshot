// oneshot · MIT © 2026 Artem Islamov
// lint — быстрая проверка кода ролика до рендера (без браузера):
//   синтаксис встроенных скриптов (node --check), комментарий //, съевший вызов, элементы разметки, которые не используются.
//   oneshot lint comp.html
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { run, log } from './util.mjs';

export async function lint(comp, { quiet = false } = {}) {
  const html = readFileSync(comp, 'utf8'), problems = [], warns = [];
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => ({ code: m[1], line: html.slice(0, m.index).split('\n').length }));
  const tmp = mkdtempSync(join(os.tmpdir(), 'oneshot-lint-'));
  for (const [i, s] of scripts.entries()) {
    const f = join(tmp, `s${i}.js`); writeFileSync(f, s.code);
    try { await run(process.execPath, ['--check', f]); }
    catch (e) { const m = String(e.message).match(/s\d+\.js:(\d+)\n([\s\S]*?)\n\n([^\n]+)/); problems.push(m ? `синтаксис, строка ${s.line + +m[1] - 1}: ${m[3]}` : 'синтаксис: ' + String(e.message).split('\n').slice(-3).join(' ')); }
  }
  rmSync(tmp, { recursive: true, force: true });
  // комментарий после кода, внутри которого остался вызов — он съел этот вызов
  html.split('\n').forEach((line, i) => { const m = line.match(/^(\s*\S.*?[;)}])\s*\/\/(.*)$/); if (m && !/https?:$/.test(m[1]) && /\b(F|gsap|OS)\.[A-Za-z]+\(/.test(m[2])) problems.push(`строка ${i + 1}: комментарий // съел вызов — перенесите комментарий на отдельную строку`); });
  // элементы с id, на которые нигде не ссылаются — кандидаты в мусор
  const code = scripts.map(s => s.code).join('\n'), css = (html.match(/<style[\s\S]*?<\/style>/g) || []).join('\n');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]).filter(id => !['stage', 'world', 'ground', 'vig'].includes(id));
  for (const id of new Set(ids)) { const used = code.includes(`#${id}`) || code.includes(`'${id}'`) || code.includes(`"${id}"`) || code.includes(`\`${id}\``); if (!used) warns.push(`#${id} нигде не используется в коде — удалите из разметки или дайте ему жизнь (F.life)`); }
  // ссылки на элементы, которых нет ни в разметке, ни среди созданных в коде (.id = '…') — опечатка или удалённый элемент
  const made = new Set([...code.matchAll(/\.id\s*=\s*['"`]([\w-]+)['"`]/g)].map(m => m[1]));
  const known = new Set([...ids, 'stage', 'world', 'ground', 'vig', ...made]);
  const refs = new Set([...code.matchAll(/F\.thread\(\s*['"]([\w-]+)['"]\s*\)/g)].map(m => m[1]));
  for (const m of code.matchAll(/(['"`])#([A-Za-z][\w-]*)\1/g)) {
    const before = code.slice(Math.max(0, m.index - 8), m.index), after = code.slice(m.index + m[0].length, m.index + m[0].length + 4);
    if (/F\.seg\($/.test(before) || /^\s*\+/.test(after) || /^[0-9A-Fa-f]{3,8}$/.test(m[2])) continue;   // ключ сегмента, имя собирается в коде, цвет
    refs.add(m[2]); }
  for (const r of refs) if (!known.has(r) && !r.startsWith('os-')) problems.push(`#${r} упоминается в коде, но такого элемента нет в разметке`);
  if (!quiet) {
    for (const p of problems) log('  ✗ ' + p);
    for (const w of warns) log('  ! ' + w);
    log(problems.length ? `lint: ${problems.length} ошибок` : `lint: ошибок нет${warns.length ? `, замечаний ${warns.length}` : ''}`);
  }
  return { problems, warns };
}
