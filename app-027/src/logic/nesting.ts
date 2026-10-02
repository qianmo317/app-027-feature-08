import type { Contour, NestingOverrides, Pt } from './types'
import {
  boundsContain,
  boundsOf,
  buildSegNearestTree,
  centroid,
  contourFingerprint,
  interiorPoint,
  pointInPolygon,
  polygonGapBvh,
} from './geometry'

export type TreeNode = {
  id: string
  depth: number
  parentId: string | null
  children: TreeNode[]
}

/** 拿不准的原因（界面逐条标出） */
export type NestingFlag =
  /** 与认定父级面积接近（比值 ≥ 阈值），面积排序判父子不可靠 */
  | 'area_close'
  /** 与某条轮廓贴边（间隙 < 阈值），可能本是同一断开的外框 */
  | 'boundary_touch'
  /** 代表点离自身或认定父级边界太近，点在多边形判定可能翻面 */
  | 'rep_near_edge'
  /** 有不止一个候选包含自己，自动选的不一定对 */
  | 'ambiguous'
  /** 人工指定的父级几何上并不包含这条轮廓 */
  | 'manual_not_inside'
  /** 人工判定引用的父轮廓已被删除，按顶层处理 */
  | 'manual_parent_missing'

export type ContourNestingInfo = {
  contourId: string
  parentId: string | null
  depth: number
  /** auto = 面积/代表点自动判定；manual = 人工覆盖 */
  source: 'auto' | 'manual'
  /** 自动判定时曾考虑过的父级候选 id（含最终选中的） */
  autoCandidates: string[]
  /** 拿不准的原因 */
  flags: NestingFlag[]
  /** 判定用的代表点 */
  rep: Pt | null
  /** 与认定父级的面积比（子/父，越接近 1 越可疑） */
  parentAreaRatio: number | null
  /** 与最近的大轮廓/父级的间隙 mm */
  nearestGapMm: number | null
  /** 代表点到自身边界的距离 mm */
  repEdgeMm: number | null
  /** 贴边/人工不包含时，对应的另一条轮廓 id */
  relatedId: string | null
  /** 人工判定时间戳（留痕展示） */
  manualAt: number | null
}

export type NestingResult = {
  roots: TreeNode[]
  nodeById: Map<string, TreeNode>
  depthOf: Map<string, number>
  /** 每条轮廓的判定明细（判定表数据源） */
  info: Map<string, ContourNestingInfo>
  /** 轮廓 id → 几何指纹 */
  fpOf: Map<string, string>
  /** 拿不准的轮廓数 */
  uncertainCount: number
  /** 人工判定数 */
  manualCount: number
  /** 轮廓包含关系树的最大嵌套层数（最外层记为 1） */
  maxDepth: number
  /** 判定为「在某个轮廓内部」的轮廓数 */
  nestedCount: number
}

/** 面积比（子/父）不低于该值视为「面积接近」 */
export const AREA_CLOSE_RATIO = 0.8
/** 两条轮廓间隙小于该值视为「贴边」（mm） */
export const BOUNDARY_TOUCH_MM = 0.25
/** 代表点离边小于该值视为「离边太近」（mm） */
export const REP_EDGE_MM = 0.5

type Item = {
  c: Contour
  bounds: ReturnType<typeof boundsOf>
  rep: Pt | null
  area: number
  fp: string
  repEdge: number | null
}

function boxArea(b: ReturnType<typeof boundsOf>): number {
  return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY)
}

/** 代表点到自身边界的最近距离（复用外部构建的边 BVH） */
function repToEdgeWithTree(p: Pt, tree: ReturnType<typeof buildSegNearestTree>): number {
  return tree.nearest(p)
}

/**
 * 包含关系树：面积大者为父，用「点在多边形内 + 面积排序」判定直接父子；
 * 支持人工覆盖（byFp：轮廓指纹 → 指定父指纹/null=顶层）。
 * 嵌套 3 层以上同样正确（同心三层窗花 → depth 1/2/3）。
 */
export function buildContainmentTree(contours: Contour[], overrides?: NestingOverrides): NestingResult {
  const byFp = overrides?.byFp ?? {}
  const nodeById = new Map<string, TreeNode>()
  const depthOf = new Map<string, number>()
  const info = new Map<string, ContourNestingInfo>()
  const fpOf = new Map<string, string>()

  const items: Item[] = contours.map((c) => {
    const rep = c.closed && c.points.length >= 3 ? interiorPoint(c.points) : null
    const fp = contourFingerprint(c.points, c.closed)
    fpOf.set(c.id, fp)
    return {
      c,
      bounds: boundsOf(c.points),
      rep,
      area: c.closed ? c.area : 0,
      fp,
      repEdge: null,
    }
  })
  const byId = new Map(items.map((it) => [it.c.id, it]))
  // 每条轮廓的边 BVH 只建一次，代表点贴边距离与所有成对查询共用（大轮廓 5000 点时尤其关键）
  const treeCache = new Map<string, ReturnType<typeof buildSegNearestTree>>()
  const segTreeOf = (it: Item) => {
    let t = treeCache.get(it.c.id)
    if (!t) {
      t = buildSegNearestTree(it.c.points, it.c.closed)
      treeCache.set(it.c.id, t)
    }
    return t
  }
  for (const it of items) {
    if (it.rep) it.repEdge = repToEdgeWithTree(it.rep, segTreeOf(it))
  }
  // 面积升序：找父级时从最小的候选开始，遇到第一个包含自己的即为直接父级
  const byAreaAsc = items.slice().sort((a, b) => a.area - b.area)

  /** 自动父级候选（面积/包围盒更大、代表点落在其中），面积升序的第一个即直接父级 */
  const autoCandidatesOf = (it: Item): Item[] => {
    if (!it.rep) return []
    const out: Item[] = []
    for (const cand of byAreaAsc) {
      if (cand.c.id === it.c.id || !cand.rep) continue
      // 未闭合轮廓面积为 0，用包围盒面积比较；闭合轮廓用面积
      const candSize = cand.c.closed ? cand.area : boxArea(cand.bounds)
      const mySize = it.c.closed ? it.area : boxArea(it.bounds)
      if (candSize <= mySize * 1.0001) continue
      if (!boundsContain(cand.bounds, it.bounds, 1e-6)) continue
      if (!pointInPolygon(it.rep, cand.c.points)) continue
      out.push(cand)
    }
    return out
  }

  /** 两轮廓间隙（带缓存，判定表里同一对会被问多次）；
   * 包围盒轴对齐间距已超过贴边阈值的对直接返回该下界，不进 BVH */
  const gapCache = new Map<string, number>()
  const boxGapBetween = (x: Item, y: Item): number =>
    Math.max(
      0,
      Math.max(
        x.bounds.minX - y.bounds.maxX,
        y.bounds.minX - x.bounds.maxX,
        x.bounds.minY - y.bounds.maxY,
        y.bounds.minY - x.bounds.maxY,
      ),
    )
  const gapBetween = (a: Item, b: Item): number => {
    const key = a.c.id < b.c.id ? `${a.c.id}|${b.c.id}` : `${b.c.id}|${a.c.id}`
    const cached = gapCache.get(key)
    if (cached !== undefined) return cached
    const bg = boxGapBetween(a, b)
    const g =
      bg >= BOUNDARY_TOUCH_MM
        ? bg
        : polygonGapBvh(a.c.points, b.c.points, a.c.closed, b.c.closed, segTreeOf(b), segTreeOf(a))
    gapCache.set(key, g)
    return g
  }

  // 1) 决定每条轮廓的有效父级
  const parentOf = new Map<string, string | null>()
  for (const it of items) {
    const manual = byFp[it.fp]
    const cands = autoCandidatesOf(it)
    const autoParent = cands.length > 0 ? cands[0].c.id : null
    let parentId: string | null = autoParent
    let source: 'auto' | 'manual' = 'auto'

    if (manual) {
      source = 'manual'
      if (manual.parentFp === null) {
        parentId = null
      } else {
        const target = items.find((x) => x.fp === manual.parentFp && x.c.id !== it.c.id)
        parentId = target ? target.c.id : null
      }
    }
    parentOf.set(it.c.id, parentId)

    // 2) 计算拿不准标记
    const flags: NestingFlag[] = []
    let relatedId: string | null = null
    let nearestGap: number | null = null

    const parentItem = parentId ? byId.get(parentId) ?? null : null

    // 代表点离自身边界太近
    if (it.repEdge !== null && it.repEdge < REP_EDGE_MM) flags.push('rep_near_edge')

    // 面积接近 / 代表点离父边太近 / 人工父不包含
    if (parentItem) {
      const parentSize = parentItem.c.closed ? parentItem.area : boxArea(parentItem.bounds)
      const mySize = it.c.closed ? it.area : boxArea(it.bounds)
      const ratio = parentSize > 0 ? mySize / parentSize : 0
      if (ratio >= AREA_CLOSE_RATIO) flags.push('area_close')
      const g = gapBetween(it, parentItem)
      nearestGap = g
      relatedId = parentItem.c.id
      if (g < BOUNDARY_TOUCH_MM) flags.push('boundary_touch')
      if (it.rep && !pointInPolygon(it.rep, parentItem.c.points)) {
        // 自动判定必然包含；能到这里只有人工父
        if (!flags.includes('manual_not_inside')) flags.push('manual_not_inside')
      }
    }

    // 自动判定有歧义：不止一个包含候选，且头两个候选面积接近——
    // 同心多层（候选层层套住）是正常情况，只有候选大小差不多、面积排序不可靠时才可疑
    if (source === 'auto' && cands.length > 1) {
      const sizeOf = (x: Item) => (x.c.closed ? x.area : boxArea(x.bounds))
      // 直接父是最小的候选 cands[0]；它只比次候选小一点点时，面积排序可能选错
      const r = sizeOf(cands[1]) > 0 ? sizeOf(cands[0]) / sizeOf(cands[1]) : 0
      if (r >= AREA_CLOSE_RATIO) {
        flags.push('ambiguous')
        relatedId = relatedId ?? cands[1].c.id
      }
    }

    // 人工指定的父指纹找不到轮廓
    if (source === 'manual' && manual && manual.parentFp !== null && !parentItem) {
      flags.push('manual_parent_missing')
    }

    // 贴边但最终不是父子（断成两段的外框 / 两条轮廓刚好贴边）：找最近的轮廓。
    // 不做尺寸过滤——断裂外框的两段大小可以差很多。
    // 两遍：先用「顶点到对方包围盒」的 O(1) 下界排序，只有下界已经够小（< 阈值或
    // 可能刷新当前最近值）的候选才进 BVH；大轮廓对一堆小轮廓时能省掉绝大部分下树查询。
    if (!flags.includes('boundary_touch')) {
      const pointBoxDist = (p: Pt, b: Item['bounds']): number =>
        Math.hypot(
          Math.max(b.minX - p.x, 0, p.x - b.maxX),
          Math.max(b.minY - p.y, 0, p.y - b.maxY),
        )
      const rough = items
        .filter((o) => o.c.id !== it.c.id)
        .map((o) => {
          // 用我方少量代表点（顶点采样上限 8 个）估盒距下界
          const pts = it.c.points
          const step = Math.max(1, Math.floor(pts.length / 8))
          let lb = Infinity
          for (let i = 0; i < pts.length; i += step) lb = Math.min(lb, pointBoxDist(pts[i], o.bounds))
          return { o, lb }
        })
        .filter((x) => x.lb < BOUNDARY_TOUCH_MM || (nearestGap !== null && x.lb < nearestGap))
      rough.sort((a, b) => a.lb - b.lb)
      let near: Item | null = null
      let nearGap = Infinity
      for (const { o, lb } of rough) {
        if (lb >= nearGap && lb >= BOUNDARY_TOUCH_MM) continue
        const g = gapBetween(it, o)
        if (g < nearGap) {
          nearGap = g
          near = o
        }
        if (nearGap < 1e-9) break
      }
      if (near && nearGap < BOUNDARY_TOUCH_MM) {
        flags.push('boundary_touch')
        relatedId = relatedId ?? near.c.id
        nearestGap = nearestGap === null ? nearGap : Math.min(nearestGap, nearGap)
      } else if (nearestGap === null && near) {
        nearestGap = nearGap === Infinity ? null : nearGap
      }
    }

    const parentSize = parentItem ? (parentItem.c.closed ? parentItem.area : boxArea(parentItem.bounds)) : 0
    const mySize = it.c.closed ? it.area : boxArea(it.bounds)

    info.set(it.c.id, {
      contourId: it.c.id,
      parentId,
      depth: 1,
      source,
      autoCandidates: cands.map((x) => x.c.id),
      flags,
      rep: it.rep,
      parentAreaRatio: parentItem && parentSize > 0 ? mySize / parentSize : null,
      nearestGapMm: nearestGap === null ? null : nearestGap,
      repEdgeMm: it.repEdge,
      relatedId,
      manualAt: source === 'manual' ? manual?.at ?? null : null,
    })
  }

  // 3) 人工覆盖成环防御：沿父链走，若回到自己则断开该人工边（当作顶层）
  for (const it of items) {
    const start = it.c.id
    let cur = parentOf.get(start) ?? null
    const seen = new Set<string>([start])
    while (cur) {
      if (seen.has(cur)) {
        // 环：断开起点的人工父边
        parentOf.set(start, null)
        const inf = info.get(start)
        if (inf) {
          inf.parentId = null
          inf.parentAreaRatio = null
        }
        break
      }
      seen.add(cur)
      cur = parentOf.get(cur) ?? null
    }
  }

  for (const c of contours) {
    const node: TreeNode = { id: c.id, depth: 1, parentId: parentOf.get(c.id) ?? null, children: [] }
    nodeById.set(c.id, node)
  }
  const roots: TreeNode[] = []
  for (const c of contours) {
    const node = nodeById.get(c.id) as TreeNode
    const pid = node.parentId
    if (pid) {
      const parent = nodeById.get(pid)
      if (parent) parent.children.push(node)
      else roots.push(node)
    } else {
      roots.push(node)
    }
  }
  // 深度：父 + 1
  const assign = (node: TreeNode, depth: number): void => {
    node.depth = depth
    depthOf.set(node.id, depth)
    const inf = info.get(node.id)
    if (inf) inf.depth = depth
    for (const ch of node.children) assign(ch, depth + 1)
  }
  for (const r of roots) assign(r, 1)

  // 写回 holes（直接子轮廓）
  for (const c of contours) {
    const node = nodeById.get(c.id)
    c.holes = node ? node.children.map((n) => n.id) : []
  }

  let maxDepth = 0
  for (const d of depthOf.values()) maxDepth = Math.max(maxDepth, d)

  let uncertainCount = 0
  let manualCount = 0
  for (const inf of info.values()) {
    if (inf.source === 'manual') manualCount += 1
    if (inf.flags.length > 0) uncertainCount += 1
  }

  return {
    roots,
    nodeById,
    depthOf,
    info,
    fpOf,
    uncertainCount,
    manualCount,
    maxDepth,
    nestedCount: contours.filter((c) => (parentOf.get(c.id) ?? null) !== null).length,
  }
}

/** 兜底代表点（未闭合轮廓没有 interiorPoint） */
export function fallbackRep(c: Contour): Pt {
  return c.points.length >= 3 && c.closed ? interiorPoint(c.points) : centroid(c.points)
}
