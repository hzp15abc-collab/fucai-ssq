#!/usr/bin/env node
import { checkTicket, isFuyunActive, generateCandidates, computeStats, generateTickets, coverDesign, verifyCover, DEFAULT_FILTERS, FilterOptions } from '@fucai/core';
import { loadDraws } from './data.js';
const [cmd, ...args] = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const p2 = (n: number) => String(n).padStart(2, '0');
async function main() {
  if (cmd === 'latest') { const d = (await loadDraws()).at(-1)!; console.log(`第 ${d.issue} 期 ${d.date}  红 ${d.red.map(p2).join(' ')}  蓝 ${p2(d.blue)}`); }
  else if (cmd === 'stats') { const s = computeStats(await loadDraws(), Number(opt('window', '100')));
    console.log(JSON.stringify({ window: s.window, total: s.total, hotRed: s.hotRed, coldRed: s.coldRed, hotBlue: s.hotBlue, latestShape: s.latestShape, sumP5_P95: [s.sumP5, s.sumP95] }, null, 1)); }
  else if (cmd === 'gen') { const draws = await loadDraws(); const f: FilterOptions = { ...DEFAULT_FILTERS, excludeRecent: { numbers: draws.at(-1)!.red, maxOverlap: 1 } };
    for (const t of generateTickets(Number(opt('n', '5')), f)) console.log(`红 ${t.red.map(p2).join(' ')}  蓝 ${p2(t.blue)}`); }
  else if (cmd === 'cover') { const pool = (opt('pool') ?? '').split(',').map(Number); const m = Number(opt('m', '4')), g = Number(opt('g', '4'));
    const c = coverDesign(pool, m, g); console.log(`${c.length} 注（${c.length * 2} 元），验证：${verifyCover(pool, m, g, c) ? '通过' : '失败'}`); c.forEach(x => console.log(x.map(p2).join(' '))); }
  else if (cmd === 'check') { // fucai check --issue 2026124 --ticket 3,11,17,22,23,29+9
    const draws = await loadDraws(); const issue = opt('issue') ?? draws.at(-1)!.issue; const d = draws.find(x => x.issue === issue); if (!d) throw new Error(`没有第 ${issue} 期开奖数据`);
    const [r, b] = (opt('ticket') ?? '').split('+'); const red = r.split(/[ ,]+/).filter(Boolean).map(Number), blue = Number(b);
    if (red.length !== 6 || !blue) throw new Error('--ticket 格式：1,2,3,4,5,6+7');
    const x = checkTicket({ red, blue }, d, isFuyunActive(issue, draws));
    console.log(`第 ${issue} 期 开奖 红 ${d.red.map(p2).join(' ')} 蓝 ${p2(d.blue)}\n你的号 红 ${red.map(p2).join(' ')} 蓝 ${p2(blue)}\n中红 ${x.redHits} 个，蓝${x.blueHit ? '中' : '未中'} → ${x.tierName}${x.prize != null ? `，${x.prize} 元（税前）` : ''}${x.note ? `（${x.note}）` : ''}`); }
  else if (cmd === 'cand') { const draws = await loadDraws(); const f: FilterOptions = { ...DEFAULT_FILTERS, excludeRecent: { numbers: draws.at(-1)!.red, maxOverlap: 1 } };
    for (const t of generateCandidates(Number(opt('n', '10')), f, draws.at(-1))) console.log(`红 ${t.red.map(p2).join(' ')}  蓝 ${p2(t.blue)}  冷门度 ${t.score} ${t.reasons.join('·')}`);
    console.log('冷门度只减少分奖可能，不提高中奖概率。'); }
  else console.log('用法: fucai latest | stats [--window 100] | gen [--n 5] | cand [--n 10] | check --ticket 1,2,3,4,5,6+7 [--issue 2026124] | cover --pool 1,2,... [--m 4 --g 4]\n仅供娱乐，不提高中奖概率。');
}
main().catch(e => { console.error(e); process.exit(1); });
