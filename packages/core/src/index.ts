/** 双色球核心算法：解析、统计、过滤、覆盖组合。不提高中奖概率，仅供娱乐。 */
export interface PrizeInfo { count: number; amount: number }
export interface Draw { issue: string; date: string; red: number[]; blue: number;
  /** 以下来自 500.com，开奖当晚可能为 0（尚未公布） */
  pool?: number; prize1?: PrizeInfo; prize2?: PrizeInfo; sales?: number }
export interface Ticket { red: number[]; blue: number }

export const RED_MAX = 33, BLUE_MAX = 16;
export const SOURCE_500 = 'https://datachart.500.com/ssq/history/newinc/history.php';

/** 500.com 历史页 URL；start 为短期号（如 "26125"），省略则取全部历史 */
export function historyUrl(startShort = '03001', end = '99999') { return `${SOURCE_500}?start=${startShort}&end=${end}`; }
/** 完整期号 2026124 -> 500.com 短期号 26124 */
export const toShortIssue = (issue: string) => issue.slice(2);
export const nextShortIssue = (issue: string) => String(Number(issue.slice(2)) + 1).padStart(5, '0');

/** 解析 500.com 历史页 HTML，返回按期号升序的开奖记录 */
export function parse500History(html: string): Draw[] {
  const out: Draw[] = [];
  for (const m of html.matchAll(/<tr class="t_tr1">(.*?)<\/tr>/gs)) {
    const td = [...m[1].replace(/<!--.*?-->/gs, '').matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(x => x[1].trim());
    if (td.length < 9) continue;
    const red = td.slice(1, 7).map(Number).sort((a, b) => a - b), blue = Number(td[7]);
    if (red.some(n => !(n >= 1 && n <= 33)) || !(blue >= 1 && blue <= 16)) continue;
    const num = (x?: string) => Number((x ?? '').replace(/[^0-9]/g, '')) || 0;
    const d: Draw = { issue: '20' + td[0], date: td[td.length - 1], red, blue };
    if (td.length >= 16) { d.pool = num(td[9]); d.prize1 = { count: num(td[10]), amount: num(td[11]) }; d.prize2 = { count: num(td[12]), amount: num(td[13]) }; d.sales = num(td[14]); }
    out.push(d);
  }
  return out.sort((a, b) => a.issue.localeCompare(b.issue));
}

export async function fetchHistory(startShort?: string, fetchImpl: typeof fetch = fetch): Promise<Draw[]> {
  const r = await fetchImpl(historyUrl(startShort), { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36' } });
  if (!r.ok) throw new Error(`500.com HTTP ${r.status}`);
  return parse500History(await r.text());
}

// ---------------- 统计
export interface Stats {
  window: number; total: number; latest: Draw;
  redFreq: number[]; blueFreq: number[];       // 下标 1..33 / 1..16
  redOmission: number[]; blueOmission: number[]; // 距上次出现的期数
  hotRed: number[]; coldRed: number[]; hotBlue: number[]; coldBlue: number[];
  latestShape: { odd: number; even: number; big: number; small: number; sum: number };
  sumHistogram: { from: number; to: number; count: number }[];
  sumP5: number; sumP95: number;
}
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
export const shape = (red: number[]) => {
  const odd = red.filter(n => n % 2).length, big = red.filter(n => n >= 17).length;
  return { odd, even: red.length - odd, big, small: red.length - big, sum: sum(red) };
};

export function computeStats(draws: Draw[], window = 100): Stats {
  if (!draws.length) throw new Error('no draws');
  const recent = draws.slice(-window);
  const redFreq = Array(34).fill(0), blueFreq = Array(17).fill(0);
  for (const d of recent) { d.red.forEach(n => redFreq[n]++); blueFreq[d.blue]++; }
  const redOmission = Array(34).fill(0), blueOmission = Array(17).fill(0);
  for (const n of range(33)) { let i = draws.length - 1; while (i >= 0 && !draws[i].red.includes(n)) i--; redOmission[n] = draws.length - 1 - i; }
  for (const n of range(16)) { let i = draws.length - 1; while (i >= 0 && draws[i].blue !== n) i--; blueOmission[n] = draws.length - 1 - i; }
  const byR = range(33).sort((a, b) => redFreq[b] - redFreq[a] || a - b), byB = range(16).sort((a, b) => blueFreq[b] - blueFreq[a] || a - b);
  const sums = draws.map(d => sum(d.red)).sort((a, b) => a - b);
  const hist: Stats['sumHistogram'] = [];
  for (let f = 20; f < 190; f += 10) hist.push({ from: f, to: f + 9, count: sums.filter(s => s >= f && s <= f + 9).length });
  return { window: recent.length, total: draws.length, latest: draws[draws.length - 1], redFreq, blueFreq, redOmission, blueOmission,
    hotRed: byR.slice(0, 6), coldRed: byR.slice(-6).reverse(), hotBlue: byB.slice(0, 3), coldBlue: byB.slice(-3).reverse(),
    latestShape: shape(draws[draws.length - 1].red), sumHistogram: hist,
    sumP5: sums[Math.floor(sums.length * 0.05)], sumP95: sums[Math.floor(sums.length * 0.95)] };
}

// ---------------- 过滤
export interface FilterOptions {
  excludeRecent?: { numbers: number[]; maxOverlap: number } | null; // 与上期红球最多重合几个
  avoidAllBirthday?: boolean;   // 6 个红球全 <= 31（生日号扎堆，易与人分奖）
  maxConsecutive?: number | null; // 最长连号长度上限
  sumRange?: [number, number] | null;
  oddRange?: [number, number] | null;
}
export const DEFAULT_FILTERS: FilterOptions = { avoidAllBirthday: true, maxConsecutive: 2, sumRange: [60, 145], oddRange: [1, 5] };

/** 返回不通过的原因；通过返回 null */
export function checkFilters(red: number[], o: FilterOptions): string | null {
  const s = [...red].sort((a, b) => a - b);
  if (o.excludeRecent) { const set = new Set(o.excludeRecent.numbers); if (s.filter(n => set.has(n)).length > o.excludeRecent.maxOverlap) return '与上期重号过多'; }
  if (o.avoidAllBirthday && s.every(n => n <= 31)) return '全是生日号(≤31)';
  if (o.maxConsecutive) { let run = 1, mr = 1; for (let i = 1; i < s.length; i++) { run = s[i] === s[i - 1] + 1 ? run + 1 : 1; mr = Math.max(mr, run); } if (mr > o.maxConsecutive) return '连号过长'; }
  if (o.sumRange) { const t = sum(s); if (t < o.sumRange[0] || t > o.sumRange[1]) return '和值超范围'; }
  if (o.oddRange) { const odd = s.filter(n => n % 2).length; if (odd < o.oddRange[0] || odd > o.oddRange[1]) return '奇偶比极端'; }
  return null;
}

// ---------------- 随机
export function rng(seed = Date.now()) { let s = seed >>> 0; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32); }
export function pickK(pool: number[], k: number, rand: () => number): number[] {
  const a = [...pool]; for (let i = 0; i < k; i++) { const j = i + Math.floor(rand() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k).sort((x, y) => x - y);
}

export function generateTickets(count: number, filters: FilterOptions = DEFAULT_FILTERS, seed?: number): Ticket[] {
  const rand = rng(seed), out: Ticket[] = [], seen = new Set<string>();
  for (let tries = 0; out.length < count && tries < count * 2000; tries++) {
    const red = pickK(range(33), 6, rand); const key = red.join(',');
    if (seen.has(key) || checkFilters(red, filters)) continue;
    seen.add(key); out.push({ red, blue: 1 + Math.floor(rand() * 16) });
  }
  return out;
}

// ---------------- 覆盖组合（贪心）
export function combinations<T>(a: T[], k: number): T[][] {
  const r: T[][] = []; const c: T[] = [];
  (function f(s: number) { if (c.length === k) { r.push([...c]); return; } for (let i = s; i < a.length; i++) { c.push(a[i]); f(i + 1); c.pop(); } })(0);
  return r;
}
/**
 * 从红球池 pool 里选若干注（每注 6 个红球）：只要开奖红球中有 ≥m 个落在池内，至少有一注命中 ≥g 个红球。
 * 贪心法，不保证最少注数，但保证条件成立（verifyCover 可验证）。
 */
export function coverDesign(pool: number[], m: number, g: number): number[][] {
  if (pool.length < 6 || pool.length > 16) throw new Error('红球池需 6~16 个号码');
  if (g > m || m > 6) throw new Error('需满足 g ≤ m ≤ 6');
  const P = [...new Set(pool)].sort((a, b) => a - b);
  const targets = combinations(P, Math.min(m, P.length)).map(t => new Set(t)), cands = combinations(P, 6);
  const hit = (c: number[], t: Set<number>) => c.filter(x => t.has(x)).length >= g;
  let left = targets.map((_, i) => i); const out: number[][] = [];
  while (left.length) {
    let best = cands[0], bc = -1;
    for (const c of cands) { let n = 0; for (const i of left) if (hit(c, targets[i])) n++; if (n > bc) { bc = n; best = c; } }
    out.push(best); left = left.filter(i => !hit(best, targets[i]));
  }
  return out;
}
export function verifyCover(pool: number[], m: number, g: number, tickets: number[][]): boolean {
  return combinations([...new Set(pool)], m).every(t => tickets.some(c => c.filter(x => t.includes(x)).length >= g));
}

// ---------------- 回测
export function prizeTier(t: Ticket, d: Draw): number {
  const r = t.red.filter(n => d.red.includes(n)).length, b = t.blue === d.blue;
  if (r === 6) return b ? 1 : 2; if (r === 5 && b) return 3; if (r === 5 || (r === 4 && b)) return 4;
  if (r === 4 || (r === 3 && b)) return 5; if (b) return 6; return 0;
}
export function backtest(draws: Draw[], lastN = 1000, perDraw = 200, seed = 42) {
  const rand = rng(seed), arms = { random: { red: 0, prize: 0 }, filtered: { red: 0, prize: 0 } };
  const n = Math.min(lastN, draws.length - 1);
  for (let i = draws.length - n; i < draws.length; i++) {
    const d = draws[i], f: FilterOptions = { ...DEFAULT_FILTERS, excludeRecent: { numbers: draws[i - 1].red, maxOverlap: 1 } };
    for (const arm of ['random', 'filtered'] as const) {
      let c = 0;
      while (c < perDraw) { const red = pickK(range(33), 6, rand); if (arm === 'filtered' && checkFilters(red, f)) continue; c++;
        const t = { red, blue: 1 + Math.floor(rand() * 16) }; arms[arm].red += red.filter(x => d.red.includes(x)).length; if (prizeTier(t, d)) arms[arm].prize++; }
    }
  }
  const T = n * perDraw;
  return { draws: n, ticketsPerArm: T, theory: { meanRedHits: 36 / 33, prizeRate: 0.0671 },
    random: { meanRedHits: arms.random.red / T, prizeRate: arms.random.prize / T },
    filtered: { meanRedHits: arms.filtered.red / T, prizeRate: arms.filtered.prize / T } };
}

// ================= 奖级与派奖（依据 2026 年 1 月财政部批准的双色球游戏规则） =================
/** 已知执行「特别规定」（含福运奖：中 3 红得 5 元）的期号区间。来源：广东福彩、信息时报 2026-07 报道 */
export const FUYUN_RANGES: [string, string][] = [['2026014', '2026075']];
/**
 * 判断某期是否执行特别规定。已知区间直接返回；2026075 之后按规则推算：
 * 上一期开奖后奖池 ≥15 亿开始执行，直到某期开奖后奖池 <3 亿停止。属推算，未经官方逐期核对。
 */
export function isFuyunActive(issue: string, draws: Draw[]): boolean {
  if (FUYUN_RANGES.some(([a, b]) => issue >= a && issue <= b)) return true;
  if (issue <= '2026075') return false;
  let on = false;
  for (const d of draws) { if (d.issue <= '2026075' || d.issue >= issue) continue; if (!d.pool) continue;
    if (!on && d.pool >= 1_500_000_000) on = true; else if (on && d.pool < 300_000_000) on = false; }
  return on;
}
export const FIXED_PRIZE: Record<number, number> = { 3: 3000, 4: 200, 5: 10, 6: 5, 7: 5 };
export const TIER_NAME: Record<number, string> = { 0: '未中奖', 1: '一等奖', 2: '二等奖', 3: '三等奖', 4: '四等奖', 5: '五等奖', 6: '六等奖', 7: '福运奖' };
/** 奖级：1–6 为常规奖级，7 = 福运奖（仅特别规定期间，3 红 0 蓝），0 = 未中。只兑最高奖级 */
export function prizeTierFull(t: Ticket, d: Draw, fuyun = false): number {
  const base = prizeTier(t, d); if (base) return base;
  return fuyun && t.red.filter(n => d.red.includes(n)).length === 3 ? 7 : 0;
}
export interface TicketResult { redHits: number; blueHit: boolean; tier: number; tierName: string; prize: number | null; note?: string }
/** 对一注做复盘。一、二等奖为浮动奖金，用 500.com 公布的单注金额（未公布时 prize=null） */
export function checkTicket(t: Ticket, d: Draw, fuyun = false): TicketResult {
  const redHits = t.red.filter(n => d.red.includes(n)).length, blueHit = t.blue === d.blue, tier = prizeTierFull(t, d, fuyun);
  let prize: number | null = tier === 0 ? 0 : FIXED_PRIZE[tier] ?? null, note: string | undefined;
  if (tier === 1 || tier === 2) { const p = tier === 1 ? d.prize1 : d.prize2; prize = p?.amount ? p.amount : null; if (prize === null) note = '浮动奖金未公布'; else note = '税前，单注 >1 万元需缴 20% 个税'; }
  return { redHits, blueHit, tier, tierName: TIER_NAME[tier], prize, ...(note ? { note } : {}) };
}
export interface SavedTicket extends Ticket { id?: string; targetIssue: string; cost: number; createdAt?: number; score?: number; result?: TicketResult | null }
export function summarizeTickets(ts: SavedTicket[]) {
  const checked = ts.filter(t => t.result), spend = ts.reduce((a, t) => a + t.cost, 0), checkedSpend = checked.reduce((a, t) => a + t.cost, 0);
  const win = checked.reduce((a, t) => a + (t.result!.prize ?? 0), 0);
  const byIssue: Record<string, { tickets: number; spend: number; win: number; bestTier: number | null; best: string }> = {};
  for (const t of ts) { const b = (byIssue[t.targetIssue] ??= { tickets: 0, spend: 0, win: 0, bestTier: null, best: '待开奖' }); b.tickets++; b.spend += t.cost; b.win += t.result?.prize ?? 0;
    if (t.result) { const tr = t.result.tier || 99; if (b.bestTier === null || tr < b.bestTier) { b.bestTier = tr; b.best = t.result.tierName; } } }
  return { tickets: ts.length, pending: ts.length - checked.length, spend, checkedSpend, win, roi: checkedSpend ? (win - checkedSpend) / checkedSpend : null, byIssue };
}
/** 下一期期号。双色球每年从 001 开始；跨年时（下一次开奖日期跨入新年）用 nextDate 判断 */
export function nextIssue(latest: Draw, nextDrawYear?: number): string {
  const y = Number(latest.issue.slice(0, 4)); if (nextDrawYear && nextDrawYear > y) return `${nextDrawYear}001`;
  return `${y}${String(Number(latest.issue.slice(4)) + 1).padStart(3, '0')}`;
}
/** 下一个开奖日（周二/四/日，北京时间 21:15），不考虑春节等休市 */
export function nextDrawDate(latest: Draw): string {
  const d = new Date(latest.date + 'T12:00:00+08:00'); do d.setUTCDate(d.getUTCDate() + 1); while (![0, 2, 4].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

// ================= 冷门度评分（避免与人分奖，不提高中奖概率） =================
/**
 * 启发式「热门度」惩罚，分数 0–100，越高越冷门。依据公开研究（大众偏好 1–31 生日号、1–12 月份号、
 * 幸运数字、等差/规律图案、上期号码），**没有中国彩民实际选号数据校准**，仅为近似。
 * 只影响一、二等奖（浮动、按注均分）的分奖概率；三到六等奖为固定奖金，不受影响。
 */
export function unpopularityScore(t: Ticket, lastDraw?: Draw): { score: number; reasons: string[] } {
  const r = [...t.red].sort((a, b) => a - b); let pen = 0; const reasons: string[] = [];
  const le31 = r.filter(n => n <= 31).length, le12 = r.filter(n => n <= 12).length;
  pen += le31 * 4; if (le31 === 6) { pen += 15; reasons.push('6 个全是生日号'); }
  pen += Math.max(0, le12 - 2) * 4; if (le12 >= 4) reasons.push('月份号(≤12)偏多');
  const lucky = r.filter(n => [6, 8, 9, 16, 18, 28].includes(n)).length; pen += lucky * 3; if (lucky >= 3) reasons.push('吉利数字偏多');
  const diffs = r.slice(1).map((x, i) => x - r[i]); if (diffs.every(d => d === diffs[0])) { pen += 40; reasons.push('等差数列'); }
  if (r.every(n => n % 10 === r[0] % 10) || r.every(n => n % 2 === 0) || r.every(n => n % 2 === 1)) { pen += 10; reasons.push('规律图案'); }
  if (lastDraw) { const o = r.filter(n => lastDraw.red.includes(n)).length; pen += o * 5; if (o >= 3) reasons.push('上期号码偏多'); }
  if ([6, 8, 9, 16].includes(t.blue)) pen += 3;
  if (r.filter(n => n >= 32).length) reasons.push('含 32/33（大众少选）');
  return { score: Math.max(0, Math.min(100, Math.round(100 - pen))), reasons };
}
export interface Candidate extends Ticket { score: number; reasons: string[] }
/** 生成 n 个候选：先按过滤条件随机抽 n×8 注，再按冷门度排序取前 n */
export function generateCandidates(n: number, filters: FilterOptions = DEFAULT_FILTERS, lastDraw?: Draw, seed?: number): Candidate[] {
  return generateTickets(n * 8, filters, seed).map(t => ({ ...t, ...unpopularityScore(t, lastDraw) }))
    .sort((a, b) => b.score - a.score).slice(0, n);
}

// ================= 增量汇总（Firestore 单文档） =================
export interface Summary {
  total: number; firstIssue: string; firstDate: string; latestIssue: string;
  redCountAll: number[]; blueCountAll: number[];
  redLastIdx: number[]; blueLastIdx: number[]; // 最近一次出现的序号（0 起），-1 = 未出现
  sumHist: number[]; // 和值分桶：桶 i = [20+10i, 29+10i]，共 17 桶
  recent: Draw[];    // 最近 RECENT_KEEP 期（新的在后）
  updatedAt?: number;
}
export const RECENT_KEEP = 200;
export function emptySummary(): Summary { return { total: 0, firstIssue: '', firstDate: '', latestIssue: '', redCountAll: Array(34).fill(0), blueCountAll: Array(17).fill(0), redLastIdx: Array(34).fill(-1), blueLastIdx: Array(17).fill(-1), sumHist: Array(17).fill(0), recent: [] }; }
/** 把新开奖（按期号升序、且晚于 latestIssue）合并进汇总；已存在的期只更新奖金信息 */
export function applyDraws(s0: Summary | null, draws: Draw[]): Summary {
  const s: Summary = s0 ? JSON.parse(JSON.stringify(s0)) : emptySummary();
  for (const d of [...draws].sort((a, b) => a.issue.localeCompare(b.issue))) {
    if (s.latestIssue && d.issue <= s.latestIssue) { const i = s.recent.findIndex(x => x.issue === d.issue); if (i >= 0) s.recent[i] = d; continue; }
    const idx = s.total; if (!s.total) { s.firstIssue = d.issue; s.firstDate = d.date; }
    d.red.forEach(n => { s.redCountAll[n]++; s.redLastIdx[n] = idx; }); s.blueCountAll[d.blue]++; s.blueLastIdx[d.blue] = idx;
    const b = Math.min(16, Math.max(0, Math.floor((sum(d.red) - 20) / 10))); s.sumHist[b]++;
    s.total++; s.latestIssue = d.issue; s.recent.push(d); if (s.recent.length > RECENT_KEEP) s.recent.shift();
  }
  return s;
}
/** 由汇总得到与 computeStats 相同结构的统计（窗口 ≤ RECENT_KEEP；遗漏、和值分布用全量） */
export function statsFromSummary(s: Summary, window = 100): Stats {
  const st = computeStats(s.recent, Math.min(window, s.recent.length));
  st.total = s.total;
  st.redOmission = s.redLastIdx.map((v, i) => i === 0 ? 0 : v < 0 ? s.total : s.total - 1 - v);
  st.blueOmission = s.blueLastIdx.map((v, i) => i === 0 ? 0 : v < 0 ? s.total : s.total - 1 - v);
  st.sumHistogram = s.sumHist.map((c, i) => ({ from: 20 + 10 * i, to: 29 + 10 * i, count: c }));
  const tot = s.sumHist.reduce((a, b) => a + b, 0); let acc = 0, p5 = 0, p95 = 0;
  s.sumHist.forEach((c, i) => { if (acc < tot * 0.05 && acc + c >= tot * 0.05) p5 = 20 + 10 * i; if (acc < tot * 0.95 && acc + c >= tot * 0.95) p95 = 29 + 10 * i; acc += c; });
  st.sumP5 = p5; st.sumP95 = p95; // 分桶近似
  return st;
}

// ================= 「预测」策略回测：热号 / 冷号(遗漏) / 马尔可夫 vs 随机 =================
export type Strategy = 'random' | 'hot' | 'cold' | 'markov';
function strategyPick(kind: Strategy, hist: Draw[], rand: () => number): number[] {
  const all = range(33);
  if (kind === 'random') return pickK(all, 6, rand);
  const score = Array(34).fill(0);
  if (kind === 'hot') hist.slice(-50).forEach(d => d.red.forEach(n => score[n]++));
  if (kind === 'cold') for (const n of all) { let i = hist.length - 1; while (i >= 0 && !hist[i].red.includes(n)) i--; score[n] = hist.length - 1 - i; }
  if (kind === 'markov') { // 一阶：上期出现号码 a 时，下期出现 b 的条件频率之和
    const last = hist[hist.length - 1].red;
    for (let i = 1; i < hist.length; i++) if (hist[i - 1].red.some(a => last.includes(a))) { const w = hist[i - 1].red.filter(a => last.includes(a)).length; hist[i].red.forEach(b => score[b] += w); } }
  // 取分数最高的 6 个（同分随机打散）
  return all.map(n => [n, score[n] + rand() * 1e-6] as const).sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0]).sort((a, b) => a - b);
}
export function backtestStrategies(draws: Draw[], lastN = 1000, seed = 7, randomPerDraw = 50) {
  const rand = rng(seed), n = Math.min(lastN, draws.length - 300); const res: Record<Strategy, { picks: number; redHits: number; ge3: number }> =
    { random: { picks: 0, redHits: 0, ge3: 0 }, hot: { picks: 0, redHits: 0, ge3: 0 }, cold: { picks: 0, redHits: 0, ge3: 0 }, markov: { picks: 0, redHits: 0, ge3: 0 } };
  for (let i = draws.length - n; i < draws.length; i++) {
    const hist = draws.slice(0, i), d = draws[i];
    for (const k of ['random', 'hot', 'cold', 'markov'] as Strategy[]) for (let j = 0; j < (k === 'random' ? randomPerDraw : 1); j++) {
      const p = strategyPick(k, hist, rand), h = p.filter(x => d.red.includes(x)).length; res[k].picks++; res[k].redHits += h; if (h >= 3) res[k].ge3++; }
  }
  const pGe3 = 0.0451; // 理论：超几何分布 P(中≥3红) ≈ 4.51%
  return { draws: n, theory: { meanRedHits: 36 / 33, ge3Rate: pGe3 }, ...Object.fromEntries(Object.entries(res).map(([k, v]) => {
    const rate = v.ge3 / v.picks, se = Math.sqrt(pGe3 * (1 - pGe3) / v.picks);
    return [k, { picks: v.picks, meanRedHits: v.redHits / v.picks, ge3Rate: rate, zVsTheory: (rate - pGe3) / se }]; })) };
}

/** 截至 now 应该已开奖的最近一期日期（北京时间周二/四/日 21:15 后算已开奖；不考虑春节休市） */
export function expectedLatestDrawDate(now: Date = new Date()): string {
  const bj = new Date(now.getTime() + 8 * 3600e3); // 用 UTC 字段表示北京时间
  const d = new Date(bj); if (bj.getUTCHours() * 60 + bj.getUTCMinutes() < 21 * 60 + 15) d.setUTCDate(d.getUTCDate() - 1);
  while (![0, 2, 4].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
/** 数据是否过期：库里最新一期日期早于应开奖日期 */
export const isStale = (latestDate: string | undefined, now: Date = new Date()) => !latestDate || latestDate < expectedLatestDrawDate(now);
