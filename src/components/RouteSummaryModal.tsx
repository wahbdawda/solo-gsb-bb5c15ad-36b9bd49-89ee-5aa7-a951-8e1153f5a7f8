import { useMemo, useState } from 'react';
import { Allocation, Plan } from '../lib/model';
import { Cidr, cidrToString, contains, parseCidr, usableHosts } from '../lib/ip';
import {
  RouteSummaryResult,
  formatRouteSummaryReport,
  planRouteSummary,
} from '../lib/routeSummary';

interface Props {
  plan: Plan;
  onClose: () => void;
}

/**
 * 路由汇总弹窗：勾选子网、填写最多路由条数，生成全局最优汇总方案。
 * 命名保留段不参与勾选，但与未勾选的子网一样不可被覆盖。
 * 纯本地只读计算：不修改规划、不产生历史记录，冲突锁定期间亦可使用。
 */
export default function RouteSummaryModal({ plan, onClose }: Props) {
  const subnets = useMemo(() => {
    const out: { alloc: Allocation; cidr: Cidr }[] = [];
    for (const alloc of plan.allocations) {
      if (alloc.kind !== 'subnet') continue;
      const cidr = parseCidr(alloc.cidr);
      if (cidr) out.push({ alloc, cidr });
    }
    return out.sort((a, b) => a.cidr.base - b.cidr.base || a.cidr.prefix - b.cidr.prefix);
  }, [plan.allocations]);

  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [limit, setLimit] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<RouteSummaryResult | null>(null);
  const [copied, setCopied] = useState(false);

  const rootNameOf = (cidr: Cidr): string => {
    for (const r of plan.roots) {
      const rc = parseCidr(r.cidr);
      if (rc && contains(rc, cidr)) return r.name;
    }
    return '—';
  };

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 只统计当前仍存在的子网（规划可能被其他标签页更新）
  const chosenIds = subnets.filter((s) => checked.has(s.alloc.id)).map((s) => s.alloc.id);

  const run = () => {
    const errs: string[] = [];
    if (chosenIds.length === 0) errs.push('请至少勾选一个子网');
    const maxRoutes = Number(limit.trim());
    if (!/^\d+$/.test(limit.trim()) || !Number.isInteger(maxRoutes) || maxRoutes < 1) {
      errs.push('最多路由条数必须为不小于 1 的整数');
    }
    setErrors(errs);
    setCopied(false);
    if (errs.length > 0) {
      setResult(null);
      return;
    }
    setResult(planRouteSummary(plan, new Set(chosenIds), maxRoutes));
  };

  const report = result ? formatRouteSummaryReport(result) : '';

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      // 剪贴板 API 不可用（如非安全上下文）时回退
      const ta = document.createElement('textarea');
      ta.value = report;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>路由汇总</h3>
        <p className="muted">
          勾选需要汇总通告的<strong>子网</strong>并填写<strong>最多路由条数</strong>，系统以 CIDR
          树做全局优化：方案覆盖全部已选子网，每条汇总 CIDR 完整落在<strong>某个根网段内</strong>
          （不跨根网段），且不覆盖任何<strong>未选分配</strong>（命名保留段与未勾选的子网一律视为不可覆盖）。
          条数上限内优先<strong>最少覆盖空闲地址</strong>，代价相同时优先更少条目，结果按网络地址排序。
          纯本地只读计算，不修改规划与历史。
        </p>

        {subnets.length === 0 ? (
          <p className="muted">当前没有可汇总的子网分配。</p>
        ) : (
          <>
            <div className="summary-check-head">
              <span>
                选择子网（已选 {chosenIds.length} / {subnets.length}）
              </span>
              <span className="row-actions inline">
                <button
                  className="btn small"
                  onClick={() => setChecked(new Set(subnets.map((s) => s.alloc.id)))}
                >
                  全选
                </button>
                <button className="btn small" onClick={() => setChecked(new Set())}>
                  清空
                </button>
              </span>
            </div>
            <div className="table-wrap summary-check-list">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>名称</th>
                    <th>CIDR</th>
                    <th>可用主机</th>
                    <th>所属根网段</th>
                  </tr>
                </thead>
                <tbody>
                  {subnets.map(({ alloc, cidr }) => (
                    <tr key={alloc.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={checked.has(alloc.id)}
                          onChange={() => toggle(alloc.id)}
                        />
                      </td>
                      <td>
                        <strong>{alloc.name}</strong>
                      </td>
                      <td>
                        <code>{alloc.cidr}</code>
                      </td>
                      <td>{usableHosts(cidr.prefix).toLocaleString()}</td>
                      <td>{rootNameOf(cidr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label className="field">
              <span>最多路由条数（不小于 1 的整数）</span>
              <input
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                placeholder="例如 2"
                inputMode="numeric"
              />
            </label>
          </>
        )}

        {errors.length > 0 && (
          <ul className="errors">
            {errors.map((er, i) => (
              <li key={i}>{er}</li>
            ))}
          </ul>
        )}

        {result && (
          <div className="dhcp-result">
            <div className="dhcp-result-head">
              {result.ok ? (
                <span>
                  已选子网 {result.selectedCount} · 上限 {result.maxRoutes} 条 · 生成{' '}
                  {result.routes.length} 条 · 额外覆盖空闲地址{' '}
                  {result.totalExtraFree.toLocaleString()} 个
                </span>
              ) : (
                <span className="summary-fail">无法满足，详见下方说明</span>
              )}
              <button className="btn small" onClick={copyReport}>
                {copied ? '已复制 ✓' : '复制文本报告'}
              </button>
            </div>
            {result.ok ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>汇总 CIDR</th>
                      <th>所属根网段</th>
                      <th>覆盖的已选子网</th>
                      <th>额外空闲地址</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.routes.map((r, i) => (
                      <tr key={cidrToString(r.cidr)}>
                        <td>{i + 1}</td>
                        <td>
                          <code>{cidrToString(r.cidr)}</code>
                        </td>
                        <td>{r.rootName}</td>
                        <td>
                          {r.covered.map((a) => (
                            <div key={a.id}>
                              {a.name} <code>{a.cidr}</code>
                            </div>
                          ))}
                        </td>
                        <td>{r.extraFree.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="summary-fail">
                {result.minRequired === Number.POSITIVE_INFINITY
                  ? '存在已选子网不在任何根网段内，请检查规划数据。'
                  : `覆盖全部 ${result.selectedCount} 项已选子网且不覆盖任何未选分配，最少需要 ${result.minRequired} 条汇总路由（超过上限 ${result.maxRoutes} 条）。请提高上限后重试。`}
              </p>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={run} disabled={subnets.length === 0}>
            生成汇总方案
          </button>
        </div>
      </div>
    </div>
  );
}
