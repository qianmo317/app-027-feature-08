import type { Contour, Pt } from './types'
import { boundsContain, boundsOf, interiorPoint, nearbyGapPairs, pointInPolygon, pointSegDist } from './geometry'

export type TreeNode = {
  id: string
  depth: number
  parentId: string | null
  children: TreeNode[]
}

/** 拿不准的原因（用于核对表高亮） */
export type NestingDoubtKind =
  | 'area_close' // 父子面积接近（小轮廓包住大轮廓不太可能）
  | 'boundary_near' // 两条轮廓贴得很近（代表点可能落在缝外）
  | 'rep_near_edge' // 代表点离候选父级边界太近（点在多边形内判定不可靠）
  | 'nearby_open_frame' // 附近有条未闭合轮廓，可能是断成两段的外框
  | 'overlap_ambiguous' // 多个候选父级且彼此不是严格嵌套
  | 'manual_cycle_rejected' // 人工指定形成环，已被拒绝
  | 'manual_missing_parent' // 人工指定的父级已不存在

export type Doubt = {
  kind: NestingDoubtKind
  /** 相关的另一条轮廓（贴近的轮廓 / 失效的人工父级） */
  otherId?: string
  /** 量化数值：面积比 / 间距 mm / 代表点离边 mm */
  value?: number
  text: string
}

export type ContourNesting = {
  id: string
  /** 自动判定的父级（面积 + 代表点） */
  autoParentId: string | null
  /** 人工指定的父级；null = 顶层；undefined = 跟随自动判定 */
  manualParentId?: string | null
  /** 实际生效的父级 */
  parentId: string | null
  depth: number
  doubts: Doubt[]
  /** 判定用的代表点（闭合轮廓） */
  rep: Pt | null
  /** 代表点到生效父级边界的距离 mm（顶层为 null） */
  repEdgeDistMm: number | null
  /** 与生效父级边界的最小间距 mm（顶层为 null） */
  boundaryGapMm: number | null
  /** 是否由人工指定（含人工置顶） */
  manual: boolean
  /** 人工指定无法生效的原因（成环 / 父级缺失），生效时为 null */
  manualIssue: string | null
}

export type NestingResult = {
  roots: TreeNode[]
  nodeById: Map<string, TreeNode>
  depthOf: Map<string, number>
  /** 每条轮廓的判定明细（核对表数据源） */
  infoById: Map<string, ContourNesting>
  /** 拿不准的轮廓 id（至少一条 doubt） */
  doubtfulIds: Set<string>
  /** 人工生效中的轮廓 id */
  manualIds: Set<string>
  /** 轮廓包含关系树的最大嵌套层数（最外层记为 1） */
  maxDepth: number
  /** 判定为「在某个轮廓内部」的轮廓数 */
  nestedCount: number
}

export type ManualParentMap = Map<string, string | null>

/** 面积比高于该值认为「面积接近，父子关系可疑」（子面积 / 父面积） */
const AREA_CLOSE_RATIO = 0.8
/** 闭合轮廓之间边界间距小于该值认为贴边（mm） */
const NEAR_GAP_MM = 0.5
/** 代表点离边界小于该值认为判定不可靠（mm） */
const REP_EDGE_MM = 0.3
/** 未闭合外框候选与轮廓的贴近距离（mm） */
const OPEN_FRAME_MM = 1.0

type Item = {
  c: Contour
  area: number
  bounds: ReturnType<typeof boundsOf>
  rep: Pt | null
  open: boolean
}

function repToBoundary(p: Pt, poly: Pt[]): number {
  let best = Infinity
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const d = pointSegDist(p, poly[i], poly[(i + 1) % n])
    if (d < best) best = d
  }
  return best
}

/** 在 parentMap 上试探把 child 的父级改成 newParent，是否会成环（沿 newParent 向上走到 child） */
function createsCycle(parentMap: Map<string, string | null>, child: string, newParent: string): boolean {
  let cur: string | null = newParent
  const seen = new Set<string>()
  while (cur !== null) {
    if (cur === child || seen.has(cur)) return true
    seen.add(cur)
    cur = parentMap.get(cur) ?? null
  }
  return false
}

/**
 * 包含关系树：面积大者为父，用「点在多边形内 + 面积排序」判定直接父子。
 * 嵌套 3 层以上同样正确（同心三层窗花 → depth 1/2/3）。
 *
 * manualParents：人工覆盖（id → 父级 id，或 null = 置顶）。
 * 成环 / 父级缺失的人工指定不生效，对应轮廓打 manual_* 标记。
 */
export function buildContainmentTree(contours: Contour[], manualParents?: ManualParentMap): NestingResult {
  const items: Item[] = contours.map((c) => ({
    c,
    bounds: boundsOf(c.points),
    rep: c.closed && c.points.length >= 3 ? interiorPoint(c.points) : null,
    area: c.closed ? c.area : 0,
    open: !c.closed,
  }))
  const itemById = new Map(items.map((it) => [it.c.id, it]))
  // 面积升序：找父级时从小到大，第一个包含自己代表点的即直接父级
  const byAreaAsc = items.slice().sort((a, b) => a.area - b.area)

  // 一次全局邻近计算（最大阈值 OPEN_FRAME_MM）；贴边（NEAR_GAP_MM）从中按间距过滤，
  // 避免对同一张图建两次空间网格
  const nearAll = nearbyGapPairs(
    items.map((it) => ({ id: it.c.id, pts: it.c.points, closed: !it.open })),
    OPEN_FRAME_MM,
  )
  const closedIds = new Set(items.filter((it) => !it.open).map((it) => it.c.id))
  const nearClosed = new Map<string, Array<{ otherId: string; gap: number; otherClosed: boolean }>>()
  for (const [id, pairs] of nearAll.entries()) {
    if (!closedIds.has(id)) continue
    const closedPairs = pairs.filter((pr) => pr.gap <= NEAR_GAP_MM && closedIds.has(pr.otherId))
    if (closedPairs.length) nearClosed.set(id, closedPairs)
  }

  // 1) 自动判定
  const autoParent = new Map<string, string | null>()
  const candidatesOf = new Map<string, Item[]>()
  for (const it of items) {
    const cands: Item[] = []
    let parent: Item | null = null
    if (it.rep) {
      for (const cand of byAreaAsc) {
        if (cand.c.id === it.c.id || cand.open || !cand.rep) continue
        if (cand.area <= it.area * 1.0001) continue
        if (!boundsContain(cand.bounds, it.bounds, 1e-6)) continue
        if (!pointInPolygon(it.rep, cand.c.points)) continue
        cands.push(cand)
        if (!parent) parent = cand
      }
    }
    autoParent.set(it.c.id, parent ? parent.c.id : null)
    candidatesOf.set(it.c.id, cands)
  }

  // 2) 人工覆盖（带环检测）
  const effParent = new Map<string, string | null>(autoParent)
  const manualIssue = new Map<string, string | null>()
  const manualIds = new Set<string>()
  if (manualParents) {
    for (const [id, mp] of manualParents) {
      if (!itemById.has(id)) continue // 轮廓已删除
      manualIds.add(id)
      if (mp === null) {
        effParent.set(id, null)
        manualIssue.set(id, null)
        continue
      }
      if (!itemById.has(mp)) {
        manualIssue.set(id, '人工指定的父级轮廓已不存在')
        continue
      }
      if (mp === id || createsCycle(effParent, id, mp)) {
        manualIssue.set(id, '指定后会形成嵌套环')
        continue
      }
      effParent.set(id, mp)
      manualIssue.set(id, null)
    }
  }

  // 3) 建树 + 深度
  const nodeById = new Map<string, TreeNode>()
  const depthOf = new Map<string, number>()
  for (const c of contours) {
    nodeById.set(c.id, { id: c.id, depth: 1, parentId: effParent.get(c.id) ?? null, children: [] })
  }
  const roots: TreeNode[] = []
  for (const c of contours) {
    const node = nodeById.get(c.id)!
    const pid = node.parentId
    if (pid && nodeById.has(pid)) nodeById.get(pid)!.children.push(node)
    else {
      node.parentId = null
      roots.push(node)
    }
  }
  const visiting = new Set<string>()
  const assign = (node: TreeNode, depth: number): void => {
    if (visiting.has(node.id)) return
    visiting.add(node.id)
    node.depth = depth
    depthOf.set(node.id, depth)
    for (const ch of node.children) assign(ch, depth + 1)
  }
  for (const r of roots) assign(r, 1)

  // 4) 不确定性标记
  const doubts = new Map<string, Doubt[]>()
  const doubtfulIds = new Set<string>()
  const addDoubt = (id: string, d: Doubt): void => {
    let list = doubts.get(id)
    if (!list) {
      list = []
      doubts.set(id, list)
    }
    // 同类 + 同关联轮廓只保留一条（取数值更极端的）
    const ex = list.findIndex((x) => x.kind === d.kind && x.otherId === d.otherId)
    if (ex >= 0) {
      if (d.kind === 'area_close') {
        if ((d.value ?? 0) > (list[ex].value ?? 0)) list[ex] = d
      }
      return
    }
    list.push(d)
    doubtfulIds.add(id)
  }

  for (const it of items) {
    const id = it.c.id
    const pid = effParent.get(id) ?? null
    const issue = manualIssue.get(id)
    const isManual = manualIds.has(id) && !issue

    if (issue) {
      const mp = manualParents?.get(id)
      addDoubt(id, {
        kind: mp !== undefined && mp !== null && !itemById.has(mp) ? 'manual_missing_parent' : 'manual_cycle_rejected',
        otherId: mp ?? undefined,
        text: issue,
      })
    }

    // 4a) 与生效父级面积接近
    if (pid) {
      const p = itemById.get(pid)
      if (p && p.area > 0) {
        const ratio = it.area / p.area
        if (ratio >= AREA_CLOSE_RATIO) {
          addDoubt(id, {
            kind: 'area_close',
            otherId: pid,
            value: ratio,
            text: `与父级面积接近（子/父 = ${(ratio * 100).toFixed(0)}%），父子方向可疑`,
          })
        }
      }
    }

    // 4b) 代表点离生效父级边界太近
    if (pid && it.rep) {
      const p = itemById.get(pid)
      if (p) {
        const red = repToBoundary(it.rep, p.c.points)
        if (red <= REP_EDGE_MM) {
          addDoubt(id, {
            kind: 'rep_near_edge',
            otherId: pid,
            value: red,
            text: `代表点距父级边界仅 ${red.toFixed(2)}mm（≤ ${REP_EDGE_MM}mm），内外判定可能翻转`,
          })
        }
      }
    }

    // 4c) 与其他闭合轮廓贴边（含生效父级）——外框断裂 / 两条轮廓刚好贴边
    for (const pr of nearClosed.get(id) ?? []) {
      addDoubt(id, {
        kind: 'boundary_near',
        otherId: pr.otherId,
        value: pr.gap,
        text:
          pr.otherId === pid
            ? `与父级边界间距仅 ${pr.gap.toFixed(2)}mm（≤ ${NEAR_GAP_MM}mm），贴边可能认错`
            : `与邻近轮廓间距仅 ${pr.gap.toFixed(2)}mm（≤ ${NEAR_GAP_MM}mm），贴边可能认错父子`,
      })
    }

    // 4d) 多个包含候选且彼此不是严格嵌套（判定有歧义）
    if (!isManual) {
      const cands = candidatesOf.get(id) ?? []
      outer: for (let i = 0; i < cands.length; i++) {
        for (let j = i + 1; j < cands.length; j++) {
          if (!boundsContain(cands[i].bounds, cands[j].bounds, 1e-6) && !boundsContain(cands[j].bounds, cands[i].bounds, 1e-6)) {
            addDoubt(id, {
              kind: 'overlap_ambiguous',
              otherId: cands[i].c.id,
              text: '多个轮廓的包含范围互相重叠，自动选取了面积最接近的一个',
            })
            break outer
          }
        }
      }
    }

    // 4e) 顶层轮廓附近有未闭合折线（可能是断成两段的外框）
    if (!pid) {
      for (const pr of nearAll.get(id) ?? []) {
        if (!pr.otherClosed) {
          addDoubt(id, {
            kind: 'nearby_open_frame',
            otherId: pr.otherId,
            value: pr.gap,
            text: `附近有未闭合轮廓（间距 ${pr.gap.toFixed(2)}mm），可能是断开的外框，本层归属需核对`,
          })
          break
        }
      }
    }
  }

  // 5) 组装明细
  const infoById = new Map<string, ContourNesting>()
  for (const it of items) {
    const id = it.c.id
    const pid = effParent.get(id) ?? null
    const pItem = pid ? itemById.get(pid) : null
    let boundaryGap: number | null = null
    if (pid) {
      const pr = (nearAll.get(id) ?? []).find((x) => x.otherId === pid)
      boundaryGap = pr ? pr.gap : null
    }
    infoById.set(id, {
      id,
      autoParentId: autoParent.get(id) ?? null,
      manualParentId: manualParents?.get(id),
      parentId: pid,
      depth: depthOf.get(id) ?? 1,
      doubts: doubts.get(id) ?? [],
      rep: it.rep,
      repEdgeDistMm: pid && pItem && it.rep ? repToBoundary(it.rep, pItem.c.points) : null,
      boundaryGapMm: boundaryGap,
      manual: manualIds.has(id) && !manualIssue.get(id),
      manualIssue: manualIssue.get(id) ?? null,
    })
  }

  // 写回 holes（直接子轮廓）——派生值
  for (const c of contours) {
    c.holes = nodeById.get(c.id)?.children.map((n) => n.id) ?? []
  }

  let maxDepth = 0
  for (const d of depthOf.values()) maxDepth = Math.max(maxDepth, d)

  return {
    roots,
    nodeById,
    depthOf,
    infoById,
    doubtfulIds,
    manualIds: new Set([...manualIds].filter((id) => !manualIssue.get(id))),
    maxDepth,
    nestedCount: contours.filter((c) => (effParent.get(c.id) ?? null) !== null).length,
  }
}
