import type { Contour, Pt } from './types'
import type { ManualParentMap } from './nesting'

/**
 * 人工父子判定的跨导入留痕。
 * 台账不存轮廓 id（重新导入会全部换新 id），而存几何指纹：
 *   shapeFp（整张图样）+ contourFp（轮廓）+ parentFp（父级轮廓，null = 顶层）。
 * 同一份 SVG 再次导入时，按指纹把人工判定恢复到新轮廓上。
 */

const LS_KEY = 'papercut-plotter-studio/nesting-overrides/v1'

export type NestingOverride = {
  shapeFp: string
  contourFp: string
  /** null 表示人工置顶；字符串为父级轮廓指纹 */
  parentFp: string | null
  updatedAt: number
}

type Ledger = { version: 1; overrides: NestingOverride[] }

/** 坐标量化（mm，3 位小数，与内部 round3 一致） */
function q(v: number): number {
  return Math.round(v * 1000) / 1000
}

/** 边向量序列（平移无关） */
function edgeTokens(pts: Pt[], closed: boolean): string[] {
  if (pts.length < 2) return pts.map((p) => `${q(p.x)},${q(p.y)}`)
  const toks: string[] = []
  const n = pts.length
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    toks.push(`${q(b.x - a.x)},${q(b.y - a.y)}`)
  }
  return toks
}

/** FNV-1a 哈希 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

function minCyclic(toks: string[]): string {
  const n = toks.length
  if (n === 0) return ''
  // Booth 算法求字典序最小旋转
  const f = [...toks, ...toks]
  let i = 0
  let j = 1
  let k = 0
  while (i < n && j < n && k < n) {
    const cmp = f[i + k] < f[j + k] ? -1 : f[i + k] > f[j + k] ? 1 : 0
    if (cmp === 0) k += 1
    else {
      if (cmp > 0) i = i + k + 1
      else j = j + k + 1
      if (i === j) j += 1
      k = 0
    }
  }
  const start = Math.min(i, j)
  return toks.slice(start).concat(toks.slice(0, start)).join(';')
}

/**
 * 单条轮廓指纹：闭合轮廓对「起点 / 顺逆时针」无关，
 * 对「平移」无关；开放折线保留原始方向与起点。
 */
export function contourFingerprint(pts: Pt[], closed: boolean): string {
  if (pts.length === 0) return 'c0:empty'
  let toks = edgeTokens(pts, closed)
  if (!closed) {
    // 开放折线：归一化到 bbox 起点（平移无关），方向保留
    const minX = Math.min(...pts.map((p) => p.x))
    const minY = Math.min(...pts.map((p) => p.y))
    toks = pts.map((p) => `${q(p.x - minX)},${q(p.y - minY)}`)
    return `o${pts.length}:${fnv1a(toks.join(';'))}`
  }
  const fwd = minCyclic(toks)
  const rev = minCyclic([...toks].reverse())
  // 反向也视为同一条（重复路径合并会保留其中一种方向）
  const canon = fwd < rev ? fwd : rev
  return `c${pts.length}:${fnv1a(canon)}`
}

/** 整张图样指纹：轮廓指纹排序后聚合（与元素 / 轮廓顺序无关） */
export function shapeFingerprint(contours: Pick<Contour, 'points' | 'closed'>[]): string {
  const fps = contours.map((c) => contourFingerprint(c.points, c.closed)).sort()
  return `sh${contours.length}:${fnv1a(fps.join('|'))}`
}

export function contourFingerprintMap(contours: Contour[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const c of contours) m.set(c.id, contourFingerprint(c.points, c.closed))
  return m
}

// ---------------- 台账持久化 ----------------

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

let cache: Ledger | null = null

function load(): Ledger {
  if (cache) return cache
  cache = { version: 1, overrides: [] }
  if (canUseStorage()) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Ledger
        if (parsed && Array.isArray(parsed.overrides)) cache = { version: 1, overrides: parsed.overrides }
      }
    } catch {
      // 台账损坏不致命，从头开始
    }
  }
  return cache
}

function save(): void {
  if (!canUseStorage() || !cache) return
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cache))
  } catch {
    // 配额满等情况忽略
  }
}

/**
 * 按一批覆盖记录（shapeFp + contourFp）解析到当前轮廓 id 上。
 * 父级轮廓在当前图里找不到时（比如父级被删了）该条跳过，但记录保留。
 * 纯函数，不依赖 localStorage（自检 / 复用用）。
 */
export function resolveOverrides(
  shapeFp: string,
  fps: Map<string, string>,
  entries: NestingOverride[],
): ManualParentMap {
  const byFp = new Map<string, string>()
  for (const [id, fp] of fps) byFp.set(fp, id)
  const out: ManualParentMap = new Map()
  for (const ov of entries) {
    if (ov.shapeFp !== shapeFp) continue
    const contourId = byFp.get(ov.contourFp)
    if (!contourId) continue
    if (ov.parentFp === null) {
      out.set(contourId, null)
    } else {
      const parentId = byFp.get(ov.parentFp)
      if (!parentId) continue
      out.set(contourId, parentId)
    }
  }
  return out
}

/**
 * 把台账中属于这张图样的人工判定解析到当前轮廓 id 上。
 * 父级轮廓在当前图里找不到时（比如父级被删了）该条跳过，但台账保留，
 * 下次重新导入完整图样时仍会恢复。
 */
export function overridesForShape(shapeFp: string, fps: Map<string, string>): ManualParentMap {
  return resolveOverrides(shapeFp, fps, load().overrides)
}

/** 写入 / 更新一条人工判定（parentId 为 null 表示置顶） */
export function recordOverride(
  shapeFp: string,
  fps: Map<string, string>,
  contourId: string,
  parentId: string | null,
): void {
  const contourFp = fps.get(contourId)
  if (!contourFp) return
  const parentFp = parentId ? fps.get(parentId) ?? null : null
  if (parentId && parentFp === null) return
  const ledger = load()
  const i = ledger.overrides.findIndex((o) => o.shapeFp === shapeFp && o.contourFp === contourFp)
  const entry: NestingOverride = { shapeFp, contourFp, parentFp, updatedAt: Date.now() }
  if (i >= 0) ledger.overrides[i] = entry
  else ledger.overrides.push(entry)
  save()
}

/** 删除一条人工判定（恢复自动） */
export function clearOverride(shapeFp: string, fps: Map<string, string>, contourId: string): void {
  const contourFp = fps.get(contourId)
  if (!contourFp) return
  const ledger = load()
  ledger.overrides = ledger.overrides.filter((o) => !(o.shapeFp === shapeFp && o.contourFp === contourFp))
  save()
}

/** 这张图样当前有多少条人工判定（父级轮廓缺失、暂时无法恢复的也计数） */
export function overrideCountForShape(shapeFp: string): number {
  return load().overrides.filter((o) => o.shapeFp === shapeFp).length
}
