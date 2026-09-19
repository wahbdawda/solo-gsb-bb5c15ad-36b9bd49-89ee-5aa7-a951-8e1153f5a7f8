import { describe, expect, it } from 'vitest';
import { Allocation, Plan } from './model';
import { parseCidr } from './ip';
import { formatRouteSummaryReport, planRouteSummary } from './routeSummary';

const alloc = (name: string, cidr: string, kind: Allocation['kind'] = 'subnet'): Allocation => ({
  id: `a_${name}`,
  name,
  kind,
  prefix: parseCidr(cidr)!.prefix,
  cidr,
});

const mkPlan = (roots: string[], allocations: Allocation[]): Plan => ({
  version: 1,
  roots: roots.map((cidr, i) => ({ id: `r${i}`, name: `根${i}`, cidr })),
  allocations,
});

const select = (...allocs: Allocation[]) => new Set(allocs.map((a) => a.id));

describe('路由汇总：基本合并', () => {
  it('伙伴块零代价合并为一条路由', () => {
    const a = alloc('A', '10.0.1.0/25');
    const b = alloc('B', '10.0.1.128/25');
    const result = planRouteSummary(mkPlan(['10.0.0.0/16'], [a, b]), select(a, b), 1);
    expect(result.ok).toBe(true);
    expect(result.minRequired).toBe(1);
    expect(result.routes.map((r) => r.cidr)).toEqual([parseCidr('10.0.1.0/24')]);
    expect(result.totalExtraFree).toBe(0);
    expect(result.routes[0].covered.map((x) => x.name)).toEqual(['A', 'B']);
    expect(result.routes[0].rootName).toBe('根0');
  });

  it('上限为 1 时被迫覆盖空闲地址，上限放宽后零代价', () => {
    const a = alloc('A', '10.0.0.0/24');
    const b = alloc('B', '10.0.2.0/24');
    const plan = mkPlan(['10.0.0.0/16'], [a, b]);

    const one = planRouteSummary(plan, select(a, b), 1);
    expect(one.ok).toBe(true);
    expect(one.routes.map((r) => r.cidr)).toEqual([parseCidr('10.0.0.0/22')]);
    // /22 共 1024 地址，减去两个 /24 的 512，额外覆盖 512 个空闲地址
    expect(one.routes[0].extraFree).toBe(512);
    expect(one.totalExtraFree).toBe(512);
    expect(one.routes[0].covered.map((x) => x.name)).toEqual(['A', 'B']);

    const two = planRouteSummary(plan, select(a, b), 2);
    expect(two.ok).toBe(true);
    expect(two.routes.map((r) => r.cidr)).toEqual([
      parseCidr('10.0.0.0/24'),
      parseCidr('10.0.2.0/24'),
    ]);
    expect(two.totalExtraFree).toBe(0);
  });

  it('代价相同时优先更少条目', () => {
    const a = alloc('A', '10.0.1.0/25');
    const b = alloc('B', '10.0.1.128/25');
    const plan = mkPlan(['10.0.0.0/16'], [a, b]);
    // 上限 5：/24 一条即可零代价覆盖，不应拆成两条 /25
    const result = planRouteSummary(plan, select(a, b), 5);
    expect(result.ok).toBe(true);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].cidr).toEqual(parseCidr('10.0.1.0/24'));
  });
});

describe('路由汇总：未选分配不可覆盖', () => {
  it('保留段阻断合并：条数不足时给出最少所需条数', () => {
    const a = alloc('A', '10.0.0.0/25');
    const x = alloc('X', '10.0.0.128/25', 'reserved');
    const b = alloc('B', '10.0.1.0/25');
    const plan = mkPlan(['10.0.0.0/16'], [a, x, b]);

    const one = planRouteSummary(plan, select(a, b), 1);
    expect(one.ok).toBe(false);
    expect(one.minRequired).toBe(2);
    expect(one.routes).toEqual([]);

    const two = planRouteSummary(plan, select(a, b), 2);
    expect(two.ok).toBe(true);
    expect(two.routes.map((r) => r.cidr)).toEqual([
      parseCidr('10.0.0.0/25'),
      parseCidr('10.0.1.0/25'),
    ]);
    expect(two.totalExtraFree).toBe(0);
  });

  it('未勾选的子网同样不可被覆盖', () => {
    const a = alloc('A', '10.0.0.0/25');
    const b = alloc('B', '10.0.0.128/25');
    const plan = mkPlan(['10.0.0.0/16'], [a, b]);
    // 只勾选 A：即使合成 /24 更省条目，也不得覆盖未勾选的 B
    const result = planRouteSummary(plan, select(a), 5);
    expect(result.ok).toBe(true);
    expect(result.routes.map((r) => r.cidr)).toEqual([parseCidr('10.0.0.0/25')]);
    expect(result.totalExtraFree).toBe(0);
  });

  it('深层 /32 场景：精确计算额外覆盖的空闲地址', () => {
    const x = alloc('X', '10.0.0.0/29', 'reserved');
    const a = alloc('A', '10.0.0.8/32');
    const b = alloc('B', '10.0.0.9/32');
    const c = alloc('C', '10.0.0.11/32');
    const plan = mkPlan(['10.0.0.0/16'], [x, a, b, c]);

    // 一条路由：最小覆盖块为 10.0.0.8/30，额外覆盖空闲地址 10.0.0.10 共 1 个
    const one = planRouteSummary(plan, select(a, b, c), 1);
    expect(one.ok).toBe(true);
    expect(one.minRequired).toBe(1);
    expect(one.routes.map((r) => r.cidr)).toEqual([parseCidr('10.0.0.8/30')]);
    expect(one.routes[0].extraFree).toBe(1);
    expect(one.routes[0].covered.map((t) => t.name)).toEqual(['A', 'B', 'C']);

    // 两条路由：.8/31 零代价合并，.11 单独一条，零额外覆盖
    const two = planRouteSummary(plan, select(a, b, c), 2);
    expect(two.ok).toBe(true);
    expect(two.routes.map((r) => r.cidr)).toEqual([
      parseCidr('10.0.0.8/31'),
      parseCidr('10.0.0.11/32'),
    ]);
    expect(two.totalExtraFree).toBe(0);

    // 三条上限：代价相同（0），优先更少条目，仍为两条
    const three = planRouteSummary(plan, select(a, b, c), 3);
    expect(three.ok).toBe(true);
    expect(three.routes).toHaveLength(2);
  });
});

describe('路由汇总：多根网段', () => {
  it('不得跨根网段合并，即使地址相邻', () => {
    const a = alloc('A', '10.0.0.0/25');
    const b = alloc('B', '10.0.1.0/25');
    const plan = mkPlan(['10.0.0.0/24', '10.0.1.0/24'], [a, b]);

    const one = planRouteSummary(plan, select(a, b), 1);
    expect(one.ok).toBe(false);
    expect(one.minRequired).toBe(2);

    const two = planRouteSummary(plan, select(a, b), 2);
    expect(two.ok).toBe(true);
    expect(two.routes.map((r) => r.cidr)).toEqual([
      parseCidr('10.0.0.0/25'),
      parseCidr('10.0.1.0/25'),
    ]);
    // 每条路由完整落在各自根网段内
    expect(two.routes[0].rootName).toBe('根0');
    expect(two.routes[1].rootName).toBe('根1');
  });

  it('条数预算在根网段间全局分配，结果按网络地址排序', () => {
    const a = alloc('A', '10.0.0.0/24');
    const b = alloc('B', '10.0.2.0/24');
    const c = alloc('C', '192.168.0.0/24');
    const d = alloc('D', '192.168.2.0/24');
    const plan = mkPlan(['10.0.0.0/16', '192.168.0.0/16'], [a, b, c, d]);

    // 共 3 条：一个根网段合并（代价 512），另一个保持两条（代价 0）
    const three = planRouteSummary(plan, select(a, b, c, d), 3);
    expect(three.ok).toBe(true);
    expect(three.routes).toHaveLength(3);
    expect(three.totalExtraFree).toBe(512);
    expect(three.routes.map((r) => r.cidr)).toEqual([
      parseCidr('10.0.0.0/22'),
      parseCidr('192.168.0.0/24'),
      parseCidr('192.168.2.0/24'),
    ]);

    // 共 4 条：全部精确覆盖，零代价
    const four = planRouteSummary(plan, select(a, b, c, d), 4);
    expect(four.ok).toBe(true);
    expect(four.routes).toHaveLength(4);
    expect(four.totalExtraFree).toBe(0);
  });
});

describe('路由汇总：边界与防御', () => {
  it('未勾选任何子网时结果为空方案', () => {
    const a = alloc('A', '10.0.0.0/24');
    const result = planRouteSummary(mkPlan(['10.0.0.0/16'], [a]), new Set(), 3);
    expect(result.ok).toBe(true);
    expect(result.routes).toEqual([]);
    expect(result.minRequired).toBe(0);
    expect(result.selectedCount).toBe(0);
  });

  it('已选子网不在任何根网段内时无法覆盖', () => {
    const a = alloc('A', '172.16.0.0/24');
    const result = planRouteSummary(mkPlan(['10.0.0.0/16'], [a]), select(a), 5);
    expect(result.ok).toBe(false);
    expect(result.minRequired).toBe(Number.POSITIVE_INFINITY);
  });

  it('不存在的勾选 id 被忽略', () => {
    const a = alloc('A', '10.0.0.0/24');
    const result = planRouteSummary(
      mkPlan(['10.0.0.0/16'], [a]),
      new Set(['a_A', 'a_不存在']),
      1,
    );
    expect(result.ok).toBe(true);
    expect(result.selectedCount).toBe(1);
    expect(result.routes.map((r) => r.cidr)).toEqual([parseCidr('10.0.0.0/24')]);
  });
});

describe('路由汇总：文本报告', () => {
  it('成功方案包含统计、每条路由与覆盖明细', () => {
    const a = alloc('办公有线', '192.168.0.0/24');
    const b = alloc('办公无线', '192.168.2.0/24');
    const result = planRouteSummary(mkPlan(['192.168.0.0/16'], [a, b]), select(a, b), 1);
    const report = formatRouteSummaryReport(result, new Date('2026-09-18T08:30:00'));
    expect(report).toContain('路由汇总报告');
    expect(report).toContain('2026-09-18 08:30:00');
    expect(report).toContain('已选子网：2 项 · 路由上限：1 条');
    expect(report).toContain('共 1 条汇总路由 · 额外覆盖空闲地址 512 个');
    expect(report).toContain('[1] 192.168.0.0/22（根网段：根0）覆盖已选子网 2 项，额外覆盖空闲地址 512 个');
    expect(report).toContain('· 办公有线  192.168.0.0/24');
    expect(report).toContain('· 办公无线  192.168.2.0/24');
  });

  it('无法满足时说明最少所需条数', () => {
    const a = alloc('A', '10.0.0.0/25');
    const x = alloc('X', '10.0.0.128/25', 'reserved');
    const b = alloc('B', '10.0.1.0/25');
    const result = planRouteSummary(mkPlan(['10.0.0.0/16'], [a, x, b]), select(a, b), 1);
    const report = formatRouteSummaryReport(result, new Date('2026-09-18T08:30:00'));
    expect(report).toContain('无法满足');
    expect(report).toContain('最少需要 2 条汇总路由，超过上限 1 条');
  });
});
