import { describe, it, expect } from 'vitest';
import { parse500History, computeStats, checkFilters, DEFAULT_FILTERS, generateTickets, coverDesign, verifyCover, prizeTier, nextShortIssue, backtest, Draw } from '../src/index';
const html = `<tr class="t_tr1"><!--<td>2</td>--><td>26124</td><td class="t_cfont2">03</td><td class="t_cfont2">11</td><td class="t_cfont2">17</td><td class="t_cfont2">22</td><td class="t_cfont2">23</td><td class="t_cfont2">29</td><td class="t_cfont4">09</td><td class="t_cfont4">&nbsp;</td><td>0</td><td>2026-10-29</td></tr>
<tr class="t_tr1"><td>26123</td><td>01</td><td>02</td><td>05</td><td>08</td><td>30</td><td>33</td><td>16</td><td>&nbsp;</td><td>2026-10-27</td></tr>`;
describe('parse', () => {
  it('parses 500.com rows ascending', () => {
    const d = parse500History(html);
    expect(d).toEqual([{ issue: '2026123', date: '2026-10-27', red: [1, 2, 5, 8, 30, 33], blue: 16 }, { issue: '2026124', date: '2026-10-29', red: [3, 11, 17, 22, 23, 29], blue: 9 }]);
  });
  it('next issue', () => expect(nextShortIssue('2026124')).toBe('26125'));
});
describe('stats', () => {
  it('freq and omission', () => {
    const s = computeStats(parse500History(html));
    expect(s.redFreq[3]).toBe(1); expect(s.redOmission[1]).toBe(1); expect(s.redOmission[3]).toBe(0); expect(s.blueOmission[16]).toBe(1);
    expect(s.latestShape).toEqual({ odd: 5, even: 1, big: 4, small: 2, sum: 105 });
  });
});
describe('filters', () => {
  it('rejects', () => {
    expect(checkFilters([1, 2, 3, 10, 20, 32], DEFAULT_FILTERS)).toBe('连号过长');
    expect(checkFilters([1, 5, 9, 13, 20, 31], DEFAULT_FILTERS)).toBe('全是生日号(≤31)');
    expect(checkFilters([3, 11, 17, 22, 25, 32], { excludeRecent: { numbers: [3, 11, 17], maxOverlap: 1 } })).toBe('与上期重号过多');
    expect(checkFilters([2, 4, 6, 8, 10, 32], DEFAULT_FILTERS)).not.toBeNull();
    expect(checkFilters([2, 9, 15, 22, 28, 33], DEFAULT_FILTERS)).toBeNull();
  });
  it('generated tickets pass filters and are unique', () => {
    const t = generateTickets(50, DEFAULT_FILTERS, 1);
    expect(t).toHaveLength(50); t.forEach(x => expect(checkFilters(x.red, DEFAULT_FILTERS)).toBeNull());
    expect(new Set(t.map(x => x.red.join())).size).toBe(50);
  });
});
describe('cover', () => {
  it('10-pool m=4 g=4 guarantee holds and beats full wheel', () => {
    const pool = [2, 5, 9, 13, 17, 20, 24, 27, 30, 33]; const c = coverDesign(pool, 4, 4);
    expect(verifyCover(pool, 4, 4, c)).toBe(true); expect(c.length).toBeLessThan(210);
  });
  it('12-pool m=5 g=4', () => { const p = [1,4,7,10,13,16,19,22,25,28,31,33]; const c = coverDesign(p, 5, 4); expect(verifyCover(p, 5, 4, c)).toBe(true); });
});
describe('prize', () => {
  const d: Draw = { issue: '1', date: '', red: [1, 2, 3, 4, 5, 6], blue: 7 };
  it('tiers', () => {
    expect(prizeTier({ red: [1, 2, 3, 4, 5, 6], blue: 7 }, d)).toBe(1); expect(prizeTier({ red: [1, 2, 3, 4, 5, 9], blue: 7 }, d)).toBe(3);
    expect(prizeTier({ red: [10, 11, 12, 13, 14, 15], blue: 7 }, d)).toBe(6); expect(prizeTier({ red: [1, 2, 3, 13, 14, 15], blue: 1 }, d)).toBe(0);
  });
  it('backtest runs', () => { const draws = parse500History(html); expect(backtest(draws, 1, 10).ticketsPerArm).toBe(10); });
});

import { checkTicket, isFuyunActive, applyDraws, statsFromSummary, unpopularityScore, generateCandidates, summarizeTickets, nextIssue, nextDrawDate, prizeTierFull, rng, pickK, parse500History as p5 } from '../src/index';
const D = (issue: string, red: number[], blue: number, extra: object = {}) => ({ issue, date: '2026-10-29', red, blue, ...extra });
describe('复盘与奖级', () => {
  const d = D('2026124', [3, 11, 17, 22, 23, 29], 9, { prize1: { count: 2, amount: 6000000 }, prize2: { count: 80, amount: 200000 } });
  it('各奖级金额', () => {
    expect(checkTicket({ red: [3, 11, 17, 22, 23, 29], blue: 9 }, d)).toMatchObject({ tier: 1, prize: 6000000 });
    expect(checkTicket({ red: [3, 11, 17, 22, 23, 29], blue: 1 }, d)).toMatchObject({ tier: 2, prize: 200000 });
    expect(checkTicket({ red: [3, 11, 17, 22, 23, 1], blue: 9 }, d)).toMatchObject({ tier: 3, prize: 3000 });
    expect(checkTicket({ red: [3, 11, 17, 22, 23, 1], blue: 1 }, d)).toMatchObject({ tier: 4, prize: 200 });
    expect(checkTicket({ red: [3, 11, 17, 22, 1, 2], blue: 9 }, d)).toMatchObject({ tier: 4, prize: 200 });
    expect(checkTicket({ red: [3, 11, 17, 22, 1, 2], blue: 1 }, d)).toMatchObject({ tier: 5, prize: 10 });
    expect(checkTicket({ red: [3, 11, 17, 1, 2, 4], blue: 9 }, d)).toMatchObject({ tier: 5, prize: 10, redHits: 3, blueHit: true });
    expect(checkTicket({ red: [1, 2, 4, 5, 6, 7], blue: 9 }, d)).toMatchObject({ tier: 6, prize: 5 });
    expect(checkTicket({ red: [3, 11, 17, 1, 2, 4], blue: 1 }, d)).toMatchObject({ tier: 0, prize: 0 });
    expect(checkTicket({ red: [3, 11, 17, 1, 2, 4], blue: 1 }, d, true)).toMatchObject({ tier: 7, prize: 5, tierName: '福运奖' });
    expect(checkTicket({ red: [3, 11, 17, 22, 23, 29], blue: 9 }, D('x', [3, 11, 17, 22, 23, 29], 9)).prize).toBeNull();
  });
  it('福运奖期间', () => { expect(isFuyunActive('2026014', [])).toBe(true); expect(isFuyunActive('2026075', [])).toBe(true); expect(isFuyunActive('2026076', [])).toBe(false); expect(isFuyunActive('2025100', [])).toBe(false);
    const h = [D('2026100', [1,2,3,4,5,6], 1, { pool: 1_600_000_000 }), D('2026101', [1,2,3,4,5,6], 1, { pool: 500_000_000 }), D('2026102', [1,2,3,4,5,6], 1, { pool: 200_000_000 })];
    expect(isFuyunActive('2026101', h)).toBe(true); expect(isFuyunActive('2026102', h)).toBe(true); expect(isFuyunActive('2026103', h)).toBe(false); });
  it('汇总统计', () => { const s = summarizeTickets([{ red: [1,2,3,4,5,6], blue: 1, targetIssue: 'a', cost: 2, result: checkTicket({ red: [1,2,3,4,5,6], blue: 9 }, d) },
      { red: [1,2,3,4,5,6], blue: 1, targetIssue: 'a', cost: 2, result: checkTicket({ red: [1,2,3,4,5,6], blue: 1 }, d) }, { red: [1,2,3,4,5,6], blue: 1, targetIssue: 'b', cost: 2 }]);
    expect(s).toMatchObject({ tickets: 3, pending: 1, spend: 6, checkedSpend: 4, win: 5, roi: 0.25 }); expect(s.byIssue.a.best).toBe('六等奖'); expect(s.byIssue.b.best).toBe('待开奖'); });
  it('下一期', () => { expect(nextIssue(d)).toBe('2026125'); expect(nextIssue(d, 2027)).toBe('2027001'); expect(nextDrawDate(d)).toBe('2026-11-01'); });
});
describe('增量汇总', () => {
  const draws = Array.from({ length: 450 }, (_, i) => { const r = rng(i + 1); return D(`2020${String(i).padStart(3, '0')}`, pickK(Array.from({ length: 33 }, (_, k) => k + 1), 6, r).sort((a, b) => a - b), 1 + (i % 16)); });
  it('分批增量 = 一次性全量，且与 computeStats 一致', () => {
    const one = applyDraws(null, draws); let inc = applyDraws(null, draws.slice(0, 100)); inc = applyDraws(inc, draws.slice(90, 300)); inc = applyDraws(inc, draws.slice(300));
    expect(inc).toEqual(one); expect(one.recent.length).toBe(200); expect(one.total).toBe(450);
    const a = statsFromSummary(one, 100), b = computeStats(draws, 100);
    expect(a.redFreq).toEqual(b.redFreq); expect(a.blueFreq).toEqual(b.blueFreq); expect(a.redOmission).toEqual(b.redOmission); expect(a.blueOmission).toEqual(b.blueOmission); expect(a.hotRed).toEqual(b.hotRed);
  });
});
describe('冷门度', () => {
  it('规律号码分低', () => { expect(unpopularityScore({ red: [1,2,3,4,5,6], blue: 8 }).score).toBeLessThan(unpopularityScore({ red: [7,14,23,29,32,33], blue: 15 }).score);
    expect(unpopularityScore({ red: [5,10,15,20,25,30], blue: 1 }).reasons).toContain('等差数列'); });
  it('候选排序且满足过滤', () => { const c = generateCandidates(10, DEFAULT_FILTERS, undefined, 3); expect(c).toHaveLength(10);
    for (let i = 1; i < c.length; i++) expect(c[i - 1].score).toBeGreaterThanOrEqual(c[i].score); c.forEach(t => expect(checkFilters(t.red, DEFAULT_FILTERS)).toBeNull());
    expect(prizeTierFull({ red: [1,2,3,7,8,9], blue: 2 }, D('x', [1,2,3,4,5,6], 1), true)).toBe(7); });
});
describe('解析奖金列', () => { it('500.com 带奖池/一二等奖的行', () => {
  const row = '<tr class="t_tr1"><!--<td>2</td>--><td>26120</td><td>13</td><td>14</td><td>16</td><td>18</td><td>20</td><td>31</td><td>03</td><td>&nbsp;</td><td>1,035,363,275</td><td>9</td><td>7,232,345</td><td>73</td><td>344,025</td><td>332,731,798</td><td>2026-10-20</td></tr>';
  expect(p5(row)[0]).toMatchObject({ issue: '2026120', blue: 3, pool: 1035363275, prize1: { count: 9, amount: 7232345 }, prize2: { count: 73, amount: 344025 }, sales: 332731798, date: '2026-10-20' }); }); });

import { expectedLatestDrawDate, isStale } from '../src/index';
describe('expectedLatestDrawDate', () => {
  it('21:15 前算上一个开奖日，之后算当天', () => {
    expect(expectedLatestDrawDate(new Date('2026-10-29T13:00:00Z'))).toBe('2026-10-27'); // 周四 21:00 BJT
    expect(expectedLatestDrawDate(new Date('2026-10-29T13:20:00Z'))).toBe('2026-10-29'); // 周四 21:20 BJT
    expect(expectedLatestDrawDate(new Date('2026-10-31T02:00:00Z'))).toBe('2026-10-29'); // 周六
    expect(expectedLatestDrawDate(new Date('2026-11-01T16:30:00Z'))).toBe('2026-11-01'); // 周一 00:30 BJT → 周日
  });
  it('isStale', () => { const now = new Date('2026-10-29T14:00:00Z');
    expect(isStale('2026-10-27', now)).toBe(true); expect(isStale('2026-10-29', now)).toBe(false); expect(isStale(undefined, now)).toBe(true); });
});
