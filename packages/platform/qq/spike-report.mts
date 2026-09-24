/** Renders the G2 spike report skeleton from real artifacts.
 *
 * The report is the exit criterion for G2, so it is assembled from the capability snapshot and the
 * redacted evidence summary rather than typed by hand. The verdict is deliberately not inferred:
 * without an explicit choice the report says so, and only the four documented verdicts are allowed.
 */
import type { PlatformCapabilitySnapshot } from '../../contracts/index.mts';
import { capabilityOverallStatus } from '../../contracts/index.mts';
import type { SpikeSummary } from './spike-evidence.mts';

export const SPIKE_VERDICTS = ['GO_CONFIRM_ONLY', 'GO_AUTO', 'CONDITIONAL', 'NO_GO'] as const;
export type SpikeVerdict = typeof SPIKE_VERDICTS[number];
export type SpikeVerdictOrUndecided = SpikeVerdict | 'UNDECIDED';

export type SpikeReportInput = {
  platform: 'qq' | 'wechat';
  dateIso: string;
  accountId: string;
  adapterVersion: string;
  snapshot: PlatformCapabilitySnapshot;
  summary: SpikeSummary;
  environment: Record<string, string>;
  /** Human judgement. Left as UNDECIDED the report states that no conclusion was reached. */
  verdict: SpikeVerdictOrUndecided;
  notes?: string;
  contractProposals?: readonly string[];
};

function table(rows: readonly (readonly string[])[]): string {
  const [head, ...body] = rows;
  return [`| ${head!.join(' | ')} |`, `| ${head!.map(() => '---').join(' | ')} |`,
    ...body.map(row => `| ${row.join(' | ')} |`)].join('\n');
}

export function renderSpikeReport(input: SpikeReportInput): string {
  if (input.snapshot.platform !== input.platform) throw new Error('SNAPSHOT_PLATFORM_MISMATCH');
  if (input.verdict !== 'UNDECIDED' && !(SPIKE_VERDICTS as readonly string[]).includes(input.verdict)) throw new Error('INVALID_VERDICT');
  const derived = capabilityOverallStatus(input.snapshot.evidence);
  const families = table([
    ['能力族', '状态', '证据来源', '限制'],
    ...input.snapshot.evidence.map(item => [item.capability, item.status, item.sourceRef,
      [...item.constraints, item.unavailableReason ?? ''].filter(Boolean).join('；') || '—']),
  ]);
  const verdictLine = input.verdict === 'UNDECIDED'
    ? '**未填写结论**：本报告不构成 go/no-go 判定，G2 保持未完成。判定只能是 `GO_CONFIRM_ONLY`、`GO_AUTO`、`CONDITIONAL` 或 `NO_GO`，并由本人确认。'
    : `**结论：${input.verdict}**（由本人确认后填写）`;
  return `# ${input.platform.toUpperCase()} 真实接入 spike 报告（${input.dateIso.slice(0, 10)}）

> 本报告由 \`npm run spike:report\` 从能力快照与去敏证据汇总生成；结论字段由人填写，生成器不会推断。模拟、公开文档与本机闭环均不作为平台实测证据。

## 路线、版本与环境

${table([
    ['项', '值'],
    ['平台与账号形态', `${input.platform} · 内部账号 ${input.accountId}`],
    ['适配器版本', input.adapterVersion],
    ['能力快照', `docs/reports/platform-${input.platform}-capability-snapshot-${input.dateIso.slice(0, 10)}.json（总体状态 ${input.snapshot.verificationStatus}，逐项推导 ${derived}）`],
    ['采样时间', input.summary.observedAt],
    ...Object.entries(input.environment).map(([key, value]) => [key, value]),
  ])}

## 能力快照（逐项证据）

${families}

## 只接收证据汇总（去敏）

\`\`\`json
${JSON.stringify(input.summary, null, 2)}
\`\`\`

## 未验证项与已知限制

${[...input.snapshot.constraints, ...input.summary.limitations].map(line => `- ${line}`).join('\n')}

## 风险与人工维护

- 非官方路线风险、许可范围与常在线依赖：见 docs/platforms/qq-spike-plan.md 与 wechat-route-options.md（按平台）。
- 人工维护频率、故障码与断线次数：由操作人在测试窗口内如实记录，未记录即视为未验证。

## 结论

${verdictLine}

${input.notes?.trim() ? `补充说明：\n\n${input.notes.trim()}\n` : ''}## 对公共契约的变更提案

${input.contractProposals?.length ? input.contractProposals.map(line => `- ${line}`).join('\n') : '- 无。若发现契约缺口，先提案，不在本地私加同名字段或状态。'}
`;
}
