// 端到端：注册上限、用户隔离、复盘（需模拟器在跑）。会清空模拟器里的 Auth 用户和 users/ 数据
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080'; process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, deleteUser } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, collection, addDoc, getDocs, updateDoc, doc } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { initializeApp as adminInit } from 'firebase-admin/app'; import { getFirestore as adminDb } from 'firebase-admin/firestore';
const P = 'demo-fucai-ssq'; adminInit({ projectId: P }); const adb = adminDb();
const app = initializeApp({ projectId: P, apiKey: 'demo-key' }); const auth = getAuth(app); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const db = getFirestore(app); connectFirestoreEmulator(db, '127.0.0.1', 8080); const fns = getFunctions(app, 'asia-east1'); connectFunctionsEmulator(fns, '127.0.0.1', 5001);
let ok = 0, bad = 0; const check = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); c ? ok++ : bad++; };
async function reset() { await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${P}/accounts`, { method: 'DELETE' }); await adb.doc('admin/registrations').delete(); await adb.recursiveDelete(adb.collection('users')); }
const err = async f => { try { await f(); return null; } catch (e) { return e; } };

// --- 方案 A：客户端直接注册 + 阻塞函数 ---
await reset(); const uids = [];
for (let i = 1; i <= 10; i++) { const c = await createUserWithEmailAndPassword(auth, `u${i}@test.com`, 'pass123'); uids.push(c.user.uid); await signOut(auth); }
check(uids.length === 10, '阻塞函数方案：前 10 个用户注册成功');
const e11 = await err(() => createUserWithEmailAndPassword(auth, 'u11@test.com', 'pass123'));
check(e11 && /注册名额已满/.test(e11.message), `第 11 个被拒：${e11?.code} ${e11?.message?.slice(0, 90)}`);
check(((await adb.doc('admin/registrations').get()).data().uids.length) === 10, '名单文档恰好 10 人');
// 并发：同时再注册 3 个，都应被拒
const par = await Promise.all([12, 13, 14].map(i => err(() => createUserWithEmailAndPassword(auth, `u${i}@test.com`, 'pass123'))));
check(par.every(e => e && /注册名额已满/.test(e.message)), '并发 3 个注册全部被拒');
// 删除一个用户 → 释放名额 → 可以再注册
const c1 = await signInWithEmailAndPassword(auth, 'u10@test.com', 'pass123'); await deleteUser(c1.user);
for (let i = 0; i < 20 && (await adb.doc('admin/registrations').get()).data().uids.length !== 9; i++) await new Promise(r => setTimeout(r, 500));
check((await adb.doc('admin/registrations').get()).data().uids.length === 9, '删除用户后释放名额（onDelete 触发器）');
check(!(await err(async () => { await createUserWithEmailAndPassword(auth, 'u15@test.com', 'pass123'); await signOut(auth); })), '释放后第 10 个名额可再注册');

// --- 用户隔离 + 复盘 ---
const A = await signInWithEmailAndPassword(auth, 'u1@test.com', 'pass123');
const latest = (await adb.doc('meta/ssq').get()).data().latestIssue; const d = (await adb.doc(`ssq_draws/${latest}`).get()).data();
await addDoc(collection(db, `users/${A.user.uid}/tickets`), { red: d.red, blue: d.blue === 1 ? 2 : 1, targetIssue: latest, cost: 2, createdAt: Date.now(), source: 'test' });
const r = await httpsCallable(fns, 'reviewMyTickets')(); check(r.data.reviewed === 1, `复盘函数处理 1 注（第 ${latest} 期）`);
const mine = (await getDocs(collection(db, `users/${A.user.uid}/tickets`))).docs.map(x => x.data());
check(mine[0]?.result?.tierName === '二等奖' && mine[0].result.prize === d.prize2.amount, `复盘结果：${mine[0]?.result?.tierName} ${mine[0]?.result?.prize} 元`);
check(!!(await err(() => updateDoc(doc(db, `users/${A.user.uid}/tickets/x`), { result: null }))) , 'A 不能改自己票的 result');
const bUid = uids[1]; await signOut(auth);
await signInWithEmailAndPassword(auth, 'u2@test.com', 'pass123');
check(!!(await err(() => getDocs(collection(db, `users/${A.user.uid}/tickets`)))), 'B 读不到 A 的票');
check(!!(await err(() => addDoc(collection(db, `users/${A.user.uid}/tickets`), { red: [1,2,3,4,5,6], blue: 1, targetIssue: '2026125', cost: 2 }))), 'B 不能往 A 名下写票');
check((await getDocs(collection(db, `users/${bUid}/tickets`))).size === 0, 'B 只看到自己的（0 注）');
await signOut(auth);
check(!!(await err(() => httpsCallable(fns, 'reviewMyTickets')())), '未登录调用复盘被拒');

// --- 方案 B：可调用函数注册 ---
await reset(); const reg = httpsCallable(fns, 'registerUser');
for (let i = 1; i <= 10; i++) await reg({ email: `c${i}@test.com`, password: 'pass123' });
check((await adb.doc('admin/registrations').get()).data().uids.length === 10, '可调用函数方案：前 10 个成功');
const eb = await err(() => reg({ email: 'c11@test.com', password: 'pass123' })); console.log('  (阻塞函数原始错误) ' + e11?.message); check(eb && /注册名额已满/.test(eb.message), `第 11 个被拒：${eb?.message}`);
const ed = await err(() => reg({ email: 'c1@test.com', password: 'pass123' })); check(ed && /该邮箱已注册/.test(ed.message), `重复邮箱被拒：${ed?.message}`);
check(!!(await signInWithEmailAndPassword(auth, 'c3@test.com', 'pass123')).user, '可调用函数建的账号能登录'); await signOut(auth);
await reset();
console.log(`\n${ok} 通过，${bad} 失败`); process.exit(bad ? 1 : 0);
