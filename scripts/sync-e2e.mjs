// 端到端（Spark 免费方案）：客户端开放注册 + sync.mjs 增量抓取 / 服务端复盘 / 10 人上限 + 用户隔离。
// 需模拟器（firestore+auth）在跑。会清空模拟器里的 Auth 用户、users/ 数据并重灌开奖数据。
import { execFileSync } from 'node:child_process';
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080'; process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.GCE_METADATA_HOST ??= '0.0.0.0:1'; process.env.METADATA_SERVER_DETECTION ??= 'none';
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, collection, addDoc, getDocs, updateDoc, doc } from 'firebase/firestore';
import { initializeApp as adminInit } from 'firebase-admin/app'; import { getFirestore as adminDb } from 'firebase-admin/firestore'; import { getAuth as adminAuth } from 'firebase-admin/auth';
const P = 'demo-fucai-ssq'; adminInit({ projectId: P }); const adb = adminDb();
const app = initializeApp({ projectId: P, apiKey: 'demo-key' }); const auth = getAuth(app); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const db = getFirestore(app); connectFirestoreEmulator(db, '127.0.0.1', 8080);
let ok = 0, bad = 0; const check = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); c ? ok++ : bad++; };
const err = async f => { try { await f(); return null; } catch (e) { return e; } };
const run = (...a) => { const o = execFileSync('node', ['scripts/sync.mjs', ...a], { env: { ...process.env, FIREBASE_SERVICE_ACCOUNT: '' }, encoding: 'utf8' }); console.log('  $ sync ' + a.join(' ') + ' → ' + o.trim().replace(/\n/g, ' | ')); return o; };
await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${P}/accounts`, { method: 'DELETE' });
await adb.recursiveDelete(adb.collection('users')); await adb.doc('admin/registrations').delete();
console.log('  ' + execFileSync('node', ['scripts/seed.mjs', '3'], { encoding: 'utf8' }).trim()); // 故意少 3 期
const before = (await adb.doc('meta/ssq').get()).data().latestIssue;

// 开放注册：12 个都能注册成功（没有阻塞函数）
const uids = [];
for (let i = 1; i <= 12; i++) { const c = await createUserWithEmailAndPassword(auth, `u${i}@test.com`, 'pass123'); uids.push(c.user.uid); await signOut(auth); await new Promise(r => setTimeout(r, 1050)) /* Auth 创建时间只精确到秒 */ }
check(uids.length === 12, 'Auth 端开放注册：12 个都建成');
// A 给尚未入库的下一期买票（下期开奖号的红球 + 错蓝 = 二等奖）
const all = (await (await import('@fucai/core')).fetchHistory(undefined)).slice(-3); const target = all[0];
const A = await signInWithEmailAndPassword(auth, 'u1@test.com', 'pass123');
await addDoc(collection(db, `users/${A.user.uid}/tickets`), { red: target.red, blue: target.blue === 1 ? 2 : 1, targetIssue: target.issue, cost: 2, createdAt: Date.now(), source: 'test' });
check(!!(await err(() => updateDoc(doc(db, `users/${A.user.uid}/tickets/x`), { result: null }))), 'A 不能自己写 result');
await signOut(auth);

const out1 = run();
check(new RegExp(`新增 3 期`).test(out1), `增量抓取补回 3 期（入库前最新 ${before}）`);
const meta = (await adb.doc('meta/ssq').get()).data(), sum = (await adb.doc('meta/ssq_summary').get()).data();
check(meta.latestIssue === all.at(-1).issue && sum.latestIssue === meta.latestIssue && typeof meta.checkedAt === 'number', `meta / 汇总更新到 ${meta.latestIssue}，带 checkedAt`);
const t = (await adb.collection(`users/${A.user.uid}/tickets`).get()).docs[0].data();
check(t.result?.tierName === '二等奖' && t.result.prize === (target.prize2?.amount || null), `服务端复盘写入：${t.result?.tierName} ${t.result?.prize} 元（第 ${target.issue} 期）`);
check(/保留 10，本次处理 2/.test(out1), '名额：第 11、12 个被禁用');
const e11 = await err(() => signInWithEmailAndPassword(auth, 'u11@test.com', 'pass123'));
check(e11?.code === 'auth/user-disabled', `第 11 个登录被拒：${e11?.code}`);
check(!(await err(async () => { await signInWithEmailAndPassword(auth, 'u10@test.com', 'pass123'); await signOut(auth); })), '第 10 个仍可登录');
check((await adb.doc('admin/registrations').get()).data().uids.join() === uids.slice(0, 10).join(), '名单 = 按创建时间的前 10 个');

const out2 = run();
check(/新增 0 期/.test(out2) && /复盘写入 0 注/.test(out2) && /本次处理 0/.test(out2), '再跑一次：无新增、不重复写、不重复禁用');

// 删除超额：删掉账号和数据
await adminAuth().deleteUser(uids[2]); // 有人退出 → 名额空出，但已禁用的不会自动恢复（需管理员手动启用）
const out3 = run('--cap-only', '--delete-extra');
check(/共 11 个账号，保留 10，本次处理 1/.test(out3), '--delete-extra：超出的 1 个被删除');

// 用户隔离
await signInWithEmailAndPassword(auth, 'u2@test.com', 'pass123');
check(!!(await err(() => getDocs(collection(db, `users/${A.user.uid}/tickets`)))), 'B 读不到 A 的票');
check(!!(await err(() => addDoc(collection(db, `users/${A.user.uid}/tickets`), { red: [1,2,3,4,5,6], blue: 1, targetIssue: '2026125', cost: 2 }))), 'B 不能往 A 名下写票');
await signOut(auth);
console.log(`\n${ok} 通过，${bad} 失败`); process.exit(bad ? 1 : 0);
