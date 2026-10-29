import { initializeApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator, collection, getDocs, getDoc, doc, addDoc, deleteDoc, query, orderBy } from 'firebase/firestore';
import { getAuth, connectAuthEmulator, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, type User } from 'firebase/auth';
import type { Summary, SavedTicket, Ticket } from '@fucai/core';
const PROJECT = import.meta.env.VITE_PROJECT_ID ?? 'demo-fucai-ssq';
// 正式部署：在 web/.env.production 填 Firebase 网页应用配置（见 docs/PROJECT.md 部署清单）
const app = initializeApp({ projectId: PROJECT, apiKey: import.meta.env.VITE_API_KEY ?? 'demo-key', authDomain: import.meta.env.VITE_AUTH_DOMAIN, appId: import.meta.env.VITE_APP_ID });
export const db = getFirestore(app);
const EMU_HOST = import.meta.env.VITE_EMULATOR_HOST ?? location.hostname;
const useEmu = (import.meta.env.VITE_USE_EMULATOR ?? 'true') === 'true';
export const auth = getAuth(app);
if (useEmu) { connectFirestoreEmulator(db, EMU_HOST, 8080); connectAuthEmulator(auth, `http://${EMU_HOST}:9099`, { disableWarnings: true }); }
/** Spark 免费方案：直接用客户端注册；名额上限由 GitHub Actions 同步脚本按创建时间清理（第 11 个起禁用） */
export const watchUser = (cb: (u: User | null) => void) => onAuthStateChanged(auth, cb);
export const register = (email: string, password: string) => createUserWithEmailAndPassword(auth, email, password);
export const login = (e: string, p: string) => signInWithEmailAndPassword(auth, e, p);
export const logout = () => signOut(auth);
export const resetPassword = (e: string) => sendPasswordResetEmail(auth, e);
/** 把 Firebase 错误翻成中文 */
export function zhError(e: any): string {
  const m = String(e?.message ?? e), c = e?.code ?? '';
  if (c === 'auth/user-disabled') return '该账号未获名额（最多 10 人）或已被停用，请联系管理员。';
  const map: Record<string, string> = { 'auth/email-already-in-use': '该邮箱已注册', 'auth/invalid-email': '邮箱格式不正确',
    'auth/weak-password': '密码至少 6 位', 'auth/invalid-credential': '邮箱或密码错误', 'auth/wrong-password': '邮箱或密码错误', 'auth/user-not-found': '该邮箱未注册',
    'auth/too-many-requests': '尝试次数过多，请稍后再试', 'auth/missing-password': '请输入密码' };
  return map[c] ?? m;
}
/** 页面只读这一个汇总文档（含最近 200 期），每次加载 1 次读取 */
export async function loadSummary(): Promise<Summary | null> { const s = await getDoc(doc(db, 'meta/ssq_summary')); return s.exists() ? s.data() as Summary : null; }
/** 数据更新时间（GitHub Actions 每次运行都会写 checkedAt） */
export async function loadMeta(): Promise<{ latestIssue?: string; checkedAt?: number } | null> { const s = await getDoc(doc(db, 'meta/ssq')); return s.exists() ? s.data() as any : null; }
const uid = () => { const u = auth.currentUser; if (!u) throw new Error('请先登录'); return u.uid; };
const col = () => collection(db, `users/${uid()}/tickets`);
export async function listTickets(): Promise<SavedTicket[]> { return (await getDocs(query(col(), orderBy('createdAt', 'desc')))).docs.map(d => ({ id: d.id, ...d.data() } as SavedTicket)); }
export async function saveTickets(ts: (Ticket & { score?: number })[], targetIssue: string, source: string) {
  for (const t of ts) await addDoc(col(), { red: [...t.red].sort((a, b) => a - b), blue: t.blue, targetIssue, cost: 2, createdAt: Date.now(), source, ...(t.score != null ? { score: t.score } : {}) });
}
export const deleteTicket = (id: string) => deleteDoc(doc(col(), id));
