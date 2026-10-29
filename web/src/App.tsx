import { useEffect, useMemo, useState } from 'react';
import { statsFromSummary, generateCandidates, coverDesign, verifyCover, DEFAULT_FILTERS, nextIssue, nextDrawDate, summarizeTickets, checkTicket, isFuyunActive, isStale, expectedLatestDrawDate, type Draw, type FilterOptions, type Candidate, type Summary, type SavedTicket } from '@fucai/core';
import { loadSummary, loadMeta, listTickets, saveTickets, deleteTicket, watchUser, register, login, logout, resetPassword, zhError } from './firebase';
import type { User } from 'firebase/auth';

const p2 = (n: number) => String(n).padStart(2, '0');
const Ball = ({ n, blue, sm, miss }: { n: number; blue?: boolean; sm?: boolean; miss?: boolean }) =>
  <span className={`ball${blue ? ' blue' : ''}${sm ? ' sm' : ''}${miss ? ' miss' : ''}`}>{p2(n)}</span>;
const Line = ({ red, blue, sm }: { red: number[]; blue: number; sm?: boolean }) =>
  <span className="balls">{red.map(n => <Ball key={n} n={n} sm={sm} />)}<Ball n={blue} blue sm={sm} /></span>;
const fmt = (t: { red: number[]; blue: number }) => t.red.map(p2).join(' ') + ' + ' + p2(t.blue);

function Bars({ data, labels, cold, blue }: { data: number[]; labels: string[]; cold?: number[]; blue?: boolean }) {
  const max = Math.max(...data, 1);
  return <><div className={`bars${blue ? ' b' : ''}`}>{data.map((v, i) => <div key={i} title={`${labels[i]}：${v}`} className={cold?.includes(i + 1) ? 'cold' : ''} style={{ height: `${(v / max) * 100}%` }} />)}</div>
    <div className="axis">{labels.map((l, i) => <span key={i}>{i % 2 === 0 || labels.length < 20 ? l : ''}</span>)}</div></>;
}
type Tab = 'home' | 'pick' | 'mine' | 'trend';

export default function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [summary, setSummary] = useState<Summary | null>(null); const draws = summary?.recent ?? [];
  const [my, setMy] = useState<SavedTicket[]>([]); const [target, setTarget] = useState('');
  const [manual, setManual] = useState('');
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [mode, setMode] = useState<'login' | 'register' | 'reset'>('login'); const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [authMsg, setAuthMsg] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [toast, setToast] = useState('');
  const [win, setWin] = useState(100);
  // 一键选号
  const [qBy, setQBy] = useState<'n' | 'yuan'>('n'); const [qVal, setQVal] = useState(5);
  const [quick, setQuick] = useState<Candidate[]>([]); const [qSel, setQSel] = useState<Set<number>>(new Set());
  // 高级选号
  const [f, setF] = useState({ recent: true, birthday: true, consec: true, sum: true, odd: true });
  const [count, setCount] = useState(10); const [tickets, setTickets] = useState<Candidate[]>([]); const [sel, setSel] = useState<Set<number>>(new Set());
  const [pool, setPool] = useState('2,5,9,13,17,20,24,27,30,33'); const [m, setM] = useState(4); const [g, setG] = useState(4);
  const [cover, setCover] = useState<{ list: number[][]; ok: boolean; ms: number } | null>(null);

  const say = (s: string) => { setToast(s); setTimeout(() => setToast(t => t === s ? '' : t), 3500); };
  const reloadMy = () => user ? listTickets().then(setMy).catch(e => setErr(String(e))) : Promise.resolve();
  // 开屏检查：库里最新一期是否早于「应已开奖」的日期（周二/四/日 21:15 后）
  const [gate, setGate] = useState<'checking' | 'stale' | 'ok' | 'done'>('checking'); const [upd, setUpd] = useState<number | null>(null);
  async function readData(first = false) {
    const [s, m] = await Promise.all([loadSummary(), loadMeta().catch(() => null)]); setSummary(s);
    setUpd(m?.checkedAt ?? (s as any)?.updatedAt ?? null);
    const stale = isStale(s?.recent.at(-1)?.date);
    if (!stale) { setGate('ok'); setTimeout(() => setGate(g => g === 'ok' ? 'done' : g), first ? 1200 : 900); } else setGate('stale');
    return s;
  }
  useEffect(() => { readData(true).catch(e => { setErr(String(e)); setGate('done'); });
    return watchUser(u => { setUser(u); if (u) listTickets().then(setMy).catch(e => setErr(String(e))); else setMy([]); }); }, []);
  async function onAuth(ev: React.FormEvent) { ev.preventDefault(); setAuthMsg('');
    try { if (mode === 'login') await login(email, pw); else if (mode === 'register') await register(email, pw);
      else { await resetPassword(email); setAuthMsg('如果这个邮箱注册过，重置密码的邮件已经发出（本地测试环境不真发信，链接在模拟器 Auth 页）'); } setPw(''); }
    catch (e) { setAuthMsg(zhError(e)); } }
  const stats = useMemo(() => summary ? statsFromSummary(summary, win) : null, [summary, win]);
  const latest = draws.at(-1);
  const next = latest ? nextIssue(latest, Number(nextDrawDate(latest).slice(0, 4))) : '';
  const nextDate = latest ? nextDrawDate(latest) : '';
  useEffect(() => { if (next && !target) setTarget(next); }, [next]);
  // 显示用：有开奖数据就在本地算（即时）；本地没有该期（超出最近 200 期）时用服务端写入的 result
  const myView = useMemo(() => my.map(t => { const d = draws.find(x => x.issue === t.targetIssue);
    return d ? { ...t, result: checkTicket(t, d, isFuyunActive(d.issue, draws)), local: !t.result } : t; }), [my, draws]);
  const sum = useMemo(() => summarizeTickets(myView), [myView]);

  async function onSave(list: { red: number[]; blue: number; score?: number }[], source: string) {
    if (!user) { say('先登录才能保存哦'); setTab('mine'); return false; }
    if (!/^\d{7}$/.test(target)) { say('期号要 7 位数字，比如 ' + next); return false; }
    try { await saveTickets(list, target, source); say(`存好了：${list.length} 注，第 ${target} 期`);
      await reloadMy(); return true; } // 已开奖期的票：页面先本地算出结果，下次同步时服务端写入 result
    catch (e) { say('保存失败：' + String(e)); return false; }
  }
  function onManual() { try { const list = manual.split(/\n+/).filter(l => l.trim()).map(l => { const n = l.split(/[^0-9]+/).filter(Boolean).map(Number);
      if (n.length !== 7 || new Set(n.slice(0, 6)).size !== 6 || n.slice(0, 6).some(x => x < 1 || x > 33) || n[6] < 1 || n[6] > 16) throw new Error('这一行不对：' + l); return { red: n.slice(0, 6), blue: n[6] }; });
    if (!list.length) return say('先输入号码');
    onSave(list, 'manual').then(ok => ok && setManual('')); } catch (e) { say(String((e as Error).message ?? e)); } }
  async function onFetch() { // 只重新读取 Firestore（数据由 GitHub Actions 定时写入）
    setBusy(true);
    try { const s = await readData(); await reloadMy(); say(isStale(s?.recent.at(-1)?.date) ? '还在更新中，稍后再看' : `已是最新（第 ${s?.latestIssue} 期）`); }
    catch (e) { say('刷新失败：' + String(e)); } finally { setBusy(false); }
  }
  const opts = (): FilterOptions => ({ excludeRecent: f.recent && latest ? { numbers: latest.red, maxOverlap: 1 } : null, avoidAllBirthday: f.birthday,
    maxConsecutive: f.consec ? DEFAULT_FILTERS.maxConsecutive : null, sumRange: f.sum ? DEFAULT_FILTERS.sumRange : null, oddRange: f.odd ? DEFAULT_FILTERS.oddRange : null });
  const qN = Math.max(1, Math.min(50, qBy === 'n' ? Math.floor(qVal || 0) : Math.floor((qVal || 0) / 2)));
  function onQuick() {
    const defaults: FilterOptions = { excludeRecent: latest ? { numbers: latest.red, maxOverlap: 1 } : null, avoidAllBirthday: true,
      maxConsecutive: DEFAULT_FILTERS.maxConsecutive, sumRange: DEFAULT_FILTERS.sumRange, oddRange: DEFAULT_FILTERS.oddRange };
    // 多生成一些，按冷门度从高到低取前 N 注
    const ranked = generateCandidates(Math.min(qN * 6, 300), defaults, latest).sort((a, b) => b.score - a.score);
    // 冷门度从高到低挑，但同一批里两注红球最多重 2 个，免得都挤在同几个号上
    const list: Candidate[] = [];
    for (const t of ranked) { if (list.length >= qN) break; const cap = Math.max(2, Math.ceil(qN * 0.4)); if (list.every(x => x.red.filter(n => t.red.includes(n)).length <= 2) && t.red.every(n => list.filter(x => x.red.includes(n)).length < cap)) list.push(t); }
    for (const t of ranked) { if (list.length >= qN) break; if (!list.includes(t)) list.push(t); }
    setQuick(list); setQSel(new Set(list.map((_, i) => i)));
  }
  async function copy(list: { red: number[]; blue: number }[]) {
    const text = `双色球 第${target}期\n` + list.map(fmt).join('\n');
    try { await navigator.clipboard.writeText(text); say(`已复制 ${list.length} 注`); }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); say(`已复制 ${list.length} 注`); }
  }
  function onGen() { setTickets(generateCandidates(count, opts(), latest)); setSel(new Set()); }
  function onCover() {
    try { const P = pool.split(/[,，\s]+/).filter(Boolean).map(Number); const t = performance.now(); const list = coverDesign(P, m, g);
      setCover({ list, ok: verifyCover(P, m, g, list), ms: performance.now() - t }); } catch (e) { say(String(e)); }
  }
  const toggles: [keyof typeof f, string][] = [['recent', '跟上期红球最多重 1 个'], ['birthday', '别全是生日号（1–31）'], ['consec', '不要 3 个连号'], ['sum', '红球加起来 60–145'], ['odd', '不要全单 / 全双']];
  const toggleIn = (s: Set<number>, i: number, set: (x: Set<number>) => void) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); set(n); };
  const IssueBox = () => <label className="issue">买第 <input inputMode="numeric" value={target} onChange={e => setTarget(e.target.value)} /> 期</label>;

  const hotTop = stats ? stats.hotRed.slice(0, 6) : [];
  const longGone = stats ? [...Array(33).keys()].map(i => i + 1).sort((a, b) => stats.redOmission[b] - stats.redOmission[a]).slice(0, 6) : [];
  const blueGone = stats ? [...Array(16).keys()].map(i => i + 1).sort((a, b) => stats.blueOmission[b] - stats.blueOmission[a]).slice(0, 3) : [];

  return <div className="app">
    <header className="top"><div className="brand"><span className="logo">福</span><div><b>双色球小助手</b><small>每周二、四、日晚 21:15 开奖</small></div></div>
      <button className="refresh" onClick={onFetch} disabled={busy}>{busy ? '刷新中…' : '↻ 刷新'}</button></header>
    {err && <div className="toast err">读不到数据：{err}</div>}
    {toast && <div className="toast">{toast}</div>}
    {gate === 'ok' && <div className="toast ok">✅ 已是最新：第 {summary?.latestIssue} 期</div>}
    {gate === 'stale' && <div className="mask"><div className="modal">
      <div className="mi">⏳</div><h2>数据正在更新</h2>
      <p>{expectedLatestDrawDate().slice(5).replace("-", " 月 ")} 日晚上的开奖结果还没同步进来。开奖后约 30–75 分钟自动更新。</p>
      <p className="muted small">现有最新：第 {summary?.latestIssue ?? '—'} 期（{summary?.recent.at(-1)?.date ?? '—'}）<br />上次更新：{upd ? new Date(upd).toLocaleString('zh-CN', { hour12: false }) : '未知'}</p>
      <button className="primary full" disabled={busy} onClick={onFetch}>{busy ? '读取中…' : '↻ 再看一下'}</button>
      <button className="ghost full" onClick={() => setGate('done')}>先用旧数据进入</button>
    </div></div>}

    <main>
    {tab === 'home' && <>
      <section className="card hero">
        <div className="hero-h"><span>上期开奖</span>{latest && <small>第 {latest.issue} 期 · {latest.date}</small>}</div>
        {latest ? <div className="balls big">{latest.red.map(n => <Ball key={n} n={n} />)}<Ball n={latest.blue} blue /></div> : <div className="muted">加载中…</div>}
        {stats && <div className="chips"><span>单双 {stats.latestShape.odd}:{stats.latestShape.even}</span><span>大小 {stats.latestShape.big}:{stats.latestShape.small}</span><span>加起来 {stats.latestShape.sum}</span></div>}
        {next && <div className="next">下一期 <b>第 {next} 期</b> · {nextDate} 开奖</div>}
      </section>
      <button className="cta" onClick={() => { setTab('pick'); setTimeout(onQuick, 0); }}>🎯 帮我选号</button>
      {stats && <section className="card"><h3>🔥 热号 <small>近 {stats.window} 期出得多</small></h3><div className="balls">{hotTop.map(n => <Ball key={n} n={n} sm />)}</div>
        <h3>💤 好久没出 <small>红球</small></h3><div className="tags">{longGone.map(n => <span key={n}><Ball n={n} sm />{stats.redOmission[n]} 期</span>)}</div>
        <h3>💤 好久没出 <small>蓝球</small></h3><div className="tags">{blueGone.map(n => <span key={n}><Ball n={n} sm blue />{stats.blueOmission[n]} 期</span>)}</div>
        <div className="muted small">热号、冷号只是过去的统计，每期都是重新摇，跟上期没关系。</div></section>}
      <section className="card"><h3>📅 最近几期</h3>
        {draws.slice(-5).reverse().map(d => <div className="draw" key={d.issue}><span className="iss">{d.issue.slice(4)}期</span><Line red={d.red} blue={d.blue} sm /></div>)}
        <button className="ghost" onClick={() => setTab('trend')}>看走势 ›</button></section>
    </>}

    {tab === 'pick' && <>
      <section className="card quick"><h2>一键选号</h2>
        <div className="seg"><button className={qBy === 'n' ? 'on' : ''} onClick={() => { setQBy('n'); setQVal(5); }}>按注数</button><button className={qBy === 'yuan' ? 'on' : ''} onClick={() => { setQBy('yuan'); setQVal(10); }}>按金额</button></div>
        <div className="qrow"><button className="step" onClick={() => setQVal(v => Math.max(qBy === 'n' ? 1 : 2, v - (qBy === 'n' ? 1 : 2)))}>－</button>
          <input className="qin" inputMode="numeric" value={qVal} onChange={e => setQVal(Number(e.target.value.replace(/\D/g, '')) || 0)} />
          <span className="unit">{qBy === 'n' ? '注' : '元'}</span>
          <button className="step" onClick={() => setQVal(v => Math.min(qBy === 'n' ? 50 : 100, v + (qBy === 'n' ? 1 : 2)))}>＋</button></div>
        <div className="presets">{(qBy === 'n' ? [1, 5, 10, 20] : [2, 10, 20, 50]).map(v => <button key={v} className={qVal === v ? 'on' : ''} onClick={() => setQVal(v)}>{v}{qBy === 'n' ? '注' : '元'}</button>)}</div>
        <div className="muted center">共 <b className="red">{qN}</b> 注 · <b className="red">{qN * 2}</b> 元（2 元一注，最多 50 注）{qBy === 'yuan' && qVal % 2 ? ' · 单数金额按少的算' : ''}</div>
        <button className="cta" onClick={onQuick}>🎲 {quick.length ? '换一批' : '帮我选'}</button>
        {quick.length > 0 && <>
          <div className="list">{quick.map((t, i) => <label key={i} className={`pick${qSel.has(i) ? ' on' : ''}`}><input type="checkbox" checked={qSel.has(i)} onChange={() => toggleIn(qSel, i, setQSel)} />
            <span className="no">{i + 1}</span><Line red={t.red} blue={t.blue} sm /></label>)}</div>
          <IssueBox />
          <div className="actions">
            <button className="primary" onClick={() => onSave(quick, 'quick')}>全部保存（{quick.length} 注）</button>
            <button disabled={!qSel.size || qSel.size === quick.length} onClick={() => onSave(quick.filter((_, i) => qSel.has(i)), 'quick')}>只存勾选的 {qSel.size} 注</button>
            <button onClick={onQuick}>换一批</button>
            <button onClick={() => copy(qSel.size ? quick.filter((_, i) => qSel.has(i)) : quick)}>复制号码</button></div>
          <div className="muted small">怎么选的：先避开大家爱买的号（生日号、连号、跟上期一样的号等），再挑“冷门度”高的。这样<b>不会更容易中</b>，只是万一中了大奖，跟别人分的少一点。</div>
        </>}
      </section>

      <details className="card adv"><summary>⚙️ 高级选号（自己定条件）</summary>
        {toggles.map(([k, l]) => <label key={k} className="sw"><span>{l}</span><input type="checkbox" checked={f[k]} onChange={e => setF({ ...f, [k]: e.target.checked })} /></label>)}
        <div className="qrow sm"><label>要几注 <input className="num" inputMode="numeric" value={count} onChange={e => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} /></label>
          <button className="primary" onClick={onGen}>按条件选</button></div>
        <div className="list">{tickets.map((t, i) => <label key={i} className={`pick${sel.has(i) ? ' on' : ''}`}><input type="checkbox" checked={sel.has(i)} onChange={() => toggleIn(sel, i, setSel)} />
          <Line red={t.red} blue={t.blue} sm /><span className="score">冷门 {t.score}</span></label>)}</div>
        {tickets.length > 0 && <><IssueBox /><div className="actions"><button className="primary" disabled={!sel.size} onClick={() => onSave(tickets.filter((_, i) => sel.has(i)), 'candidate').then(ok => ok && setSel(new Set()))}>保存勾选的 {sel.size} 注（{sel.size * 2} 元）</button>
          <button onClick={() => copy(sel.size ? tickets.filter((_, i) => sel.has(i)) : tickets)}>复制</button></div></>}
        <h3>旋转矩阵（红球包号）</h3>
        <div className="muted small">挑一组红球，算出最少买几注，能保证“池里中 m 个时至少有一注中 g 个”。只是组合游戏，不提高概率。</div>
        <input className="wide" value={pool} onChange={e => setPool(e.target.value)} />
        <div className="qrow sm"><label>池里中 ≥ <input className="num" inputMode="numeric" value={m} onChange={e => setM(Number(e.target.value))} /></label>
          <label>保 ≥ <input className="num" inputMode="numeric" value={g} onChange={e => setG(Number(e.target.value))} /></label><button className="primary" onClick={onCover}>算一下</button></div>
        {cover && <><div className="muted">共 {cover.list.length} 注（{cover.list.length * 2} 元，蓝球另选）· 验证{cover.ok ? '通过' : '没通过'} · {cover.ms.toFixed(0)} ms</div>
          <div className="list scroll">{cover.list.map((t, i) => <div className="balls" key={i}>{t.map(n => <Ball key={n} n={n} sm />)}</div>)}</div></>}
      </details>
    </>}

    {tab === 'mine' && <>
      {user === null && <section className="card auth"><h2>{mode === 'login' ? '登录' : mode === 'register' ? '注册新账号' : '找回密码'}</h2>
        <div className="muted">登录后能存下自己买的号码，开奖后自动帮你对奖。名额只有 10 个。</div>
        <form onSubmit={onAuth} className="authform">
          <input type="email" required placeholder="邮箱" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
          {mode !== 'reset' && <input type="password" required minLength={6} placeholder="密码（至少 6 位）" value={pw} onChange={e => setPw(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />}
          <button type="submit" className="cta">{mode === 'login' ? '登录' : mode === 'register' ? '注册' : '发重置邮件'}</button>
        </form>
        {authMsg && <div className="toast inline">{authMsg}</div>}
        <div className="links">{mode !== 'login' && <button className="link" onClick={() => setMode('login')}>去登录</button>}
          {mode !== 'register' && <button className="link" onClick={() => setMode('register')}>没账号？注册</button>}
          {mode !== 'reset' && <button className="link" onClick={() => setMode('reset')}>忘记密码</button>}</div>
      </section>}
      {user === undefined && <section className="card muted">加载中…</section>}
      {user && <>
        <section className="card me"><div className="who">👤 {user.email}<button className="link" onClick={() => logout()}>退出</button></div>
          <div className="kpis"><div><small>买了</small><b>{sum.tickets}注</b><small>{sum.spend} 元</small></div><div><small>中了</small><b className="red">{sum.win}</b><small>元·税前</small></div>
            <div><small>回本率</small><b>{sum.roi == null ? '—' : sum.roi >= 10 ? `${Math.round(sum.roi)}倍` : `${(sum.roi * 100).toFixed(0)}%`}</b><small>已开奖 {sum.checkedSpend} 元</small></div><div><small>等开奖</small><b>{sum.pending}注</b><small>&nbsp;</small></div></div></section>
        <section className="card"><h3>我的号码</h3>
          {myView.length === 0 && <div className="muted">还没有号码，去「选号」挑几注，或在下面手动录入。</div>}
          {Object.entries(myView.reduce<Record<string, typeof myView>>((a, t) => { (a[t.targetIssue] ||= []).push(t); return a; }, {})).sort((a, b) => b[0].localeCompare(a[0])).map(([iss, list]) => {
            const d = draws.find(x => x.issue === iss); const bi = sum.byIssue[iss];
            return <div className="grp" key={iss}><div className="grp-h"><b>第 {iss} 期</b><span>{d ? `${bi?.tickets ?? list.length} 注 · 花 ${bi?.spend ?? list.length * 2} 元 · 中 ${bi?.win ?? 0} 元` : '还没开奖'}</span></div>
              {d && <div className="draw mini"><span className="iss">开奖</span><Line red={d.red} blue={d.blue} sm /></div>}
              {list.map(t => <div className="tk" key={t.id}><span className="balls xs">{t.red.map(n => <Ball key={n} n={n} sm miss={!!d && !d.red.includes(n)} />)}<Ball n={t.blue} blue sm miss={!!d && d.blue !== t.blue} /></span>
                <span className={`res${t.result && t.result.tier ? ' win' : ''}`}>{t.result ? (t.result.tier ? `${t.result.tierName} ${t.result.prize ?? '待公布'}元` : '没中') : '等开奖'}</span>
                <button className="x" aria-label="删除" onClick={() => deleteTicket(t.id!).then(reloadMy)}>✕</button></div>)}</div>; })}
        </section>
        <details className="card"><summary>✍️ 手动录入买过的号码</summary><div className="muted small">一行一注：6 个红球 + 1 个蓝球，比如 <code>3 11 17 22 23 29 + 9</code></div>
          <textarea rows={3} value={manual} onChange={e => setManual(e.target.value)} placeholder="3 11 17 22 23 29 + 9" />
          <IssueBox /><button className="primary full" onClick={onManual}>保存</button></details>
      </>}
    </>}

    {tab === 'trend' && stats && <>
      <section className="card"><div className="hrow"><h2>走势</h2><div className="seg sm">{[30, 50, 100].map(w => <button key={w} className={win === w ? 'on' : ''} onClick={() => setWin(w)}>近{w}期</button>)}</div></div>
        <h3>红球出现次数 <small>灰色 = 冷号</small></h3><Bars data={stats.redFreq.slice(1)} labels={Array.from({ length: 33 }, (_, i) => String(i + 1))} cold={stats.coldRed} />
        <h3>蓝球出现次数</h3><Bars blue data={stats.blueFreq.slice(1)} labels={Array.from({ length: 16 }, (_, i) => String(i + 1))} />
        <h3>红球加起来的和 <small>历史 90% 在 {stats.sumP5}–{stats.sumP95}</small></h3><Bars data={stats.sumHistogram.map(h => h.count)} labels={stats.sumHistogram.map(h => String(h.from))} /></section>
      <section className="card"><h3>近 15 期</h3><div className="trend">
        {draws.slice(-15).reverse().map(d => <div className="draw" key={d.issue}><span className="iss">{d.issue.slice(4)}</span><Line red={d.red} blue={d.blue} sm /></div>)}</div></section>
      <section className="card muted small">数据来自 500 彩票网，共 {summary?.total} 期（{summary?.firstDate} 起）。回测近 1000 期：随机选和按条件选，中奖率都约 6.7%，没有差别；热号、冷号、马尔可夫等“预测”方法都没显示出稳定优势。</section>
    </>}
    {tab === 'trend' && !stats && <section className="card muted">加载中…</section>}

    <div className="disc">仅供娱乐，不提高中奖率，理性购彩。未满 18 岁不得购彩。奖金为税前。</div>
    </main>

    <nav className="tabs">{([['home', '🏠', '首页'], ['pick', '🎱', '选号'], ['mine', '🎫', '我的号码'], ['trend', '📈', '走势']] as [Tab, string, string][]).map(([k, i, l]) =>
      <button key={k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); window.scrollTo(0, 0); }}><span>{i}</span>{l}</button>)}</nav>
  </div>;
}
