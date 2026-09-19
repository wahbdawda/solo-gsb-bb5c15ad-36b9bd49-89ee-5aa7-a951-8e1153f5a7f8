/**
 * 路由汇总：在条数上限内为已选子网生成全局最优的汇总方案。
 *
 * 以 CIDR 二叉树做动态规划：
 *  - 方案必须覆盖全部已选子网，每条汇总 CIDR 完整落在某个根网段内（不跨根网段）；
 *  - 汇总路由不得覆盖任何未选分配（命名保留段与未勾选的子网一律视为不可覆盖）；
 *  - 在条数上限内优先使「额外覆盖的空闲地址」最少；代价相同时优先更少条目；
 *    结果按网络地址升序输出；
 *  - 上限不足时给出覆盖全部已选子网且不触碰未选分配的最少所需条数。
 *
 * 纯本地只读计算：不修改规划、不产生撤销/重做历史。
 */
import { Allocation, Plan } from './model';
import { Cidr, blockSize, cidrToString, compareCidr, contains, parseCidr } from './ip';

export interface SummaryRoute {
  cidr: Cidr;
  /** 所属根网段名称 */
  rootName: string;
  /** 该路由覆盖的已选子网（按网络地址升序） */
  covered: Allocation[];
  /** 额外覆盖的空闲地址数 */
  extraFree: number;
}

export interface RouteSummaryResult {
  /** false 表示条数上限不足（minRequired 给出最少所需条数） */
  ok: boolean;
  /** 汇总路由（ok 时按网络地址升序） */
  routes: SummaryRoute[];
  /** 全部路由额外覆盖的空闲地址总数 */
  totalExtraFree: number;
  /** 覆盖全部已选子网且不触碰未选分配的最少路由条数；已选子网越界时为 Infinity */
  minRequired: number;
  selectedCount: number;
  maxRoutes: number;
}

interface ParsedAlloc {
  alloc: Allocation;
  cidr: Cidr;
  selected: boolean;
}

type Choice = { type: 'self' } | { type: 'split'; leftK: number };

/** CIDR 树节点的动态规划结果：仅为「子树内含已选子网」的节点构建。 */
interface NodeSolve {
  cidr: Cidr;
  /** cost[k] = 恰好 k 条路由覆盖本子树全部已选子网时的最少额外空闲地址（下标 1 起，0 未用） */
  cost: number[];
  choice: (Choice | null)[];
  low: NodeSolve | null;
  high: NodeSolve | null;
}

const INF = Number.POSITIVE_INFINITY;

/**
 * 递归求解节点：返回用 1..cap 条合法路由覆盖子树内全部已选子网的最少额外空闲地址。
 * 合法路由 = 完整落在该节点内、且不含任何未选分配的 CIDR 块。
 * 不含已选子网的节点返回 null（无需覆盖）。
 */
function solveNode(cidr: Cidr, inside: ParsedAlloc[], maxRoutes: number): NodeSolve | null {
  const selected = inside.filter((a) => a.selected);
  if (selected.length === 0) return null;
  const selectedAddrs = selected.reduce((s, a) => s + blockSize(a.cidr.prefix), 0);
  // 每个已选子网独占一条路由必可行，更多条目无意义
  const cap = Math.min(maxRoutes, selected.length);
  const cost = new Array<number>(cap + 1).fill(INF);
  const choice = new Array<Choice | null>(cap + 1).fill(null);

  // 节点本身是一条分配：分配互不重叠，此时 inside 只含它一个，且必为已选
  const exact = inside.find(
    (a) => a.cidr.base === cidr.base && a.cidr.prefix === cidr.prefix,
  );
  if (exact) {
    cost[1] = 0;
    choice[1] = { type: 'self' };
    return { cidr, cost, choice, low: null, high: null };
  }

  // 方案一：整节点作为一条汇总路由（仅当不含任何未选分配）
  if (!inside.some((a) => !a.selected)) {
    cost[1] = blockSize(cidr.prefix) - selectedAddrs;
    choice[1] = { type: 'self' };
  }

  // 方案二：二分下钻，合并左右孩子的最优解
  let low: NodeSolve | null = null;
  let high: NodeSolve | null = null;
  if (cidr.prefix < 32) {
    const childPrefix = cidr.prefix + 1;
    const half = blockSize(childPrefix);
    const lowCidr: Cidr = { base: cidr.base, prefix: childPrefix };
    const highCidr: Cidr = { base: cidr.base + half, prefix: childPrefix };
    low = solveNode(lowCidr, inside.filter((a) => contains(lowCidr, a.cidr)), maxRoutes);
    high = solveNode(highCidr, inside.filter((a) => contains(highCidr, a.cidr)), maxRoutes);
    if (low && high) {
      for (let i = 1; i < low.cost.length; i++) {
        if (low.cost[i] === INF) continue;
        for (let j = 1; j < high.cost.length && i + j <= cap; j++) {
          if (high.cost[j] === INF) continue;
          const cand = low.cost[i] + high.cost[j];
          if (cand < cost[i + j]) {
            cost[i + j] = cand;
            choice[i + j] = { type: 'split', leftK: i };
          }
        }
      }
    } else {
      const only = low ?? high;
      if (only) {
        for (let k = 1; k < only.cost.length && k <= cap; k++) {
          if (only.cost[k] < cost[k]) {
            cost[k] = only.cost[k];
            choice[k] = { type: 'split', leftK: low ? k : 0 };
          }
        }
      }
    }
  }

  return { cidr, cost, choice, low, high };
}

/** 覆盖子树内全部已选子网的最少路由条数（不含已选子网时为 0）。 */
function minRoutesFor(cidr: Cidr, inside: ParsedAlloc[]): number {
  if (!inside.some((a) => a.selected)) return 0;
  // 无未选分配时整节点即为一条合法路由
  if (!inside.some((a) => !a.selected)) return 1;
  if (cidr.prefix >= 32) return 1; // 理论不可达：/32 内不可能同时有已选与未选
  const childPrefix = cidr.prefix + 1;
  const half = blockSize(childPrefix);
  const lowCidr: Cidr = { base: cidr.base, prefix: childPrefix };
  const highCidr: Cidr = { base: cidr.base + half, prefix: childPrefix };
  return (
    minRoutesFor(lowCidr, inside.filter((a) => contains(lowCidr, a.cidr))) +
    minRoutesFor(highCidr, inside.filter((a) => contains(highCidr, a.cidr)))
  );
}

/** 按重构信息展开节点，输出 k 条汇总 CIDR。 */
function emitRoutes(node: NodeSolve, k: number, out: Cidr[]): void {
  const ch = node.choice[k];
  if (!ch || ch.type === 'self') {
    out.push(node.cidr);
    return;
  }
  if (node.low && node.high) {
    emitRoutes(node.low, ch.leftK, out);
    emitRoutes(node.high, k - ch.leftK, out);
  } else if (node.low) {
    emitRoutes(node.low, k, out);
  } else if (node.high) {
    emitRoutes(node.high, k, out);
  }
}

/**
 * 生成路由汇总方案（纯函数）。
 *
 * @param plan 当前规划（只读）
 * @param selectedIds 勾选的子网分配 id 集合
 * @param maxRoutes 最多路由条数（调用方需保证为不小于 1 的整数）
 */
export function planRouteSummary(
  plan: Plan,
  selectedIds: ReadonlySet<string>,
  maxRoutes: number,
): RouteSummaryResult {
  const parsed: ParsedAlloc[] = [];
  for (const alloc of plan.allocations) {
    const cidr = parseCidr(alloc.cidr);
    if (!cidr) continue;
    parsed.push({ alloc, cidr, selected: selectedIds.has(alloc.id) });
  }
  const selected = parsed.filter((a) => a.selected);
  const base = {
    routes: [] as SummaryRoute[],
    totalExtraFree: 0,
    selectedCount: selected.length,
    maxRoutes,
  };
  if (selected.length === 0) {
    return { ...base, ok: true, minRequired: 0 };
  }
  const K = Math.min(maxRoutes, selected.length);

  // 逐根网段求解：汇总路由不得跨根网段
  const perRoot: { rootName: string; solve: NodeSolve }[] = [];
  const coveredIds = new Set<string>();
  let minRequired = 0;
  for (const root of plan.roots) {
    const rc = parseCidr(root.cidr);
    if (!rc) continue;
    const inside = parsed.filter((a) => contains(rc, a.cidr));
    minRequired += minRoutesFor(rc, inside);
    const solve = solveNode(rc, inside, K);
    if (solve) {
      perRoot.push({ rootName: root.name, solve });
      for (const a of inside) if (a.selected) coveredIds.add(a.alloc.id);
    }
  }
  // 已选子网不在任何根网段内（规划数据异常）：无法覆盖
  if (coveredIds.size < selected.length) {
    return { ...base, ok: false, minRequired: INF };
  }
  if (minRequired > K) {
    return { ...base, ok: false, minRequired };
  }

  // 多根网段背包：在总条数 ≤ K 下分配各根网段的用条数，使总额外空闲地址最少
  let dp = new Array<number>(K + 1).fill(INF);
  dp[0] = 0;
  const picks: number[][] = [];
  for (const { solve } of perRoot) {
    const next = new Array<number>(K + 1).fill(INF);
    const pick = new Array<number>(K + 1).fill(0);
    for (let used = 0; used <= K; used++) {
      if (dp[used] === INF) continue;
      for (let j = 1; j < solve.cost.length && used + j <= K; j++) {
        if (solve.cost[j] === INF) continue;
        const cand = dp[used] + solve.cost[j];
        if (cand < next[used + j]) {
          next[used + j] = cand;
          pick[used + j] = j;
        }
      }
    }
    picks.push(pick);
    dp = next;
  }

  // 条数上限内取代价最少；代价相同时取条目更少（升序扫描首个最小值）
  let bestK = -1;
  for (let k = 1; k <= K; k++) {
    if (dp[k] === INF) continue;
    if (bestK < 0 || dp[k] < dp[bestK]) bestK = k;
  }
  if (bestK < 0) {
    // 理论不可达：minRequired ≤ K 保证有解
    return { ...base, ok: false, minRequired };
  }

  const counts = new Array<number>(perRoot.length).fill(0);
  let rem = bestK;
  for (let i = perRoot.length - 1; i >= 0; i--) {
    counts[i] = picks[i][rem];
    rem -= counts[i];
  }

  const routes: SummaryRoute[] = [];
  perRoot.forEach(({ rootName, solve }, i) => {
    const blocks: Cidr[] = [];
    emitRoutes(solve, counts[i], blocks);
    for (const block of blocks) {
      const insideBlock = selected
        .filter((a) => contains(block, a.cidr))
        .sort((x, y) => x.cidr.base - y.cidr.base);
      const coveredAddrs = insideBlock.reduce((s, a) => s + blockSize(a.cidr.prefix), 0);
      routes.push({
        cidr: block,
        rootName,
        covered: insideBlock.map((a) => a.alloc),
        extraFree: blockSize(block.prefix) - coveredAddrs,
      });
    }
  });
  routes.sort((a, b) => compareCidr(a.cidr, b.cidr));

  return { ...base, ok: true, routes, totalExtraFree: dp[bestK], minRequired };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 生成可复制的纯文本汇总报告（顺序与结果表格一致）。 */
export function formatRouteSummaryReport(
  result: RouteSummaryResult,
  generatedAt = new Date(),
): string {
  const lines: string[] = [
    '路由汇总报告',
    `生成时间：${formatTime(generatedAt)}`,
    `已选子网：${result.selectedCount} 项 · 路由上限：${result.maxRoutes} 条`,
    '----------------------------------------',
  ];
  if (!result.ok) {
    if (result.minRequired === INF) {
      lines.push('无法满足：存在已选子网不在任何根网段内，请检查规划数据。');
    } else {
      lines.push(
        `无法满足：覆盖全部 ${result.selectedCount} 项已选子网且不覆盖任何未选分配，` +
          `最少需要 ${result.minRequired} 条汇总路由，超过上限 ${result.maxRoutes} 条。`,
      );
    }
    return lines.join('\n');
  }
  lines.push(
    `共 ${result.routes.length} 条汇总路由 · 额外覆盖空闲地址 ${result.totalExtraFree.toLocaleString()} 个`,
  );
  result.routes.forEach((r, i) => {
    lines.push(
      `[${i + 1}] ${cidrToString(r.cidr)}（根网段：${r.rootName}）` +
        `覆盖已选子网 ${r.covered.length} 项，额外覆盖空闲地址 ${r.extraFree.toLocaleString()} 个`,
    );
    for (const a of r.covered) {
      lines.push(`    · ${a.name}  ${a.cidr}`);
    }
  });
  return lines.join('\n');
}
