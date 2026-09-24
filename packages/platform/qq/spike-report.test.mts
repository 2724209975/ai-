import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSpikeReport, SPIKE_VERDICTS } from './spike-report.mts';
import type { PlatformCapabilitySnapshot } from '../../contracts/index.mts';
import type { SpikeSummary } from './spike-evidence.mts';

const snapshot: PlatformCapabilitySnapshot = {
  accountId: 'account-1', platform: 'qq', adapterVersion: 'napcat-v4.18.28-candidate', observedAt: '2026-09-24T00:00:00.000Z',
  receiveTypes: ['text', 'image', 'voice', 'unsupported'], sendTypes: ['text'], receiptLevels: ['accepted'],
  ownerMessageSignal: 'documented:message_sent', historySync: 'unknown', mediaFetch: 'unknown',
  constraints: ['候选桥未实测'], verificationStatus: 'unknown',
  evidence: [
    { capability: 'receive_types', status: 'tested', sourceRef: 'run:spike-1', observedAt: '2026-09-24T00:00:00.000Z', adapterVersion: 'v1', constraints: [] },
    { capability: 'send_types', status: 'documented', sourceRef: 'https://napneko.github.io/config/basic', observedAt: '2026-09-24T00:00:00.000Z', adapterVersion: 'v1', constraints: [] },
    { capability: 'receipt_levels', status: 'unknown', sourceRef: 'docs/platform-validation.md', observedAt: '2026-09-24T00:00:00.000Z', adapterVersion: 'v1', constraints: [], unavailableReason: '未实测' },
    { capability: 'owner_message_signal', status: 'unknown', sourceRef: 'docs/platform-validation.md', observedAt: '2026-09-24T00:00:00.000Z', adapterVersion: 'v1', constraints: [], unavailableReason: '缺 peer mapper' },
    { capability: 'history_sync', status: 'unknown', sourceRef: 'docs/platform-validation.md', observedAt: '2026-09-24T00:00:00.000Z', adapterVersion: 'v1', constraints: [], unavailableReason: '无游标证据' },
    { capability: 'media_fetch', status: 'unknown', sourceRef: 'docs/platform-validation.md', observedAt: '2026-09-24T00:00:00.000Z', adapterVersion: 'v1', constraints: [], unavailableReason: '未实测' },
  ],
};
const summary: SpikeSummary = {
  inbox: { enrolled: 4, discovery_only: 1, unmapped_self: 0 }, messagesByType: { text: 3, image: 1 }, duplicateMessageRows: 0,
  conversations: [{ state: 'PAUSED_MEDIA', count: 1 }], pauseReasons: { MEDIA_UNCERTAIN: 1 },
  tasks: { pending: 1, resolved: 0 }, sends: {}, outboxPending: 0, rawFiles: { files: 5, unreferenced: 0 },
  accountId: 'account-1', observedAt: '2026-09-25T10:00:00.000Z', limitations: ['不证明登录或送达'],
};
const base = { platform: 'qq' as const, dateIso: '2026-09-25T10:00:00.000Z', accountId: 'account-1',
  adapterVersion: 'napcat-v4.18.28-candidate', snapshot, summary, environment: { 'Node': 'v24.15.0', 'PostgreSQL': '17.11' } };

test('the report carries every section the runbook requires', () => {
  const report = renderSpikeReport({ ...base, verdict: 'CONDITIONAL' });
  for (const heading of ['## 路线、版本与环境', '## 能力快照（逐项证据）', '## 只接收证据汇总（去敏）',
    '## 未验证项与已知限制', '## 风险与人工维护', '## 结论', '## 对公共契约的变更提案']) {
    assert.ok(report.includes(heading), `missing section: ${heading}`);
  }
  assert.ok(report.includes('总体状态 unknown，逐项推导 unknown'));
  for (const item of snapshot.evidence) assert.ok(report.includes(item.capability), `missing ${item.capability}`);
  assert.ok(report.includes('"duplicateMessageRows": 0'));
});

test('the report never invents a verdict and rejects anything outside the four', () => {
  const undecided = renderSpikeReport({ ...base, verdict: 'UNDECIDED' });
  assert.ok(undecided.includes('未填写结论'));
  assert.ok(undecided.includes('G2 保持未完成'));
  for (const verdict of SPIKE_VERDICTS) assert.ok(renderSpikeReport({ ...base, verdict }).includes(`**结论：${verdict}**`));
  assert.throws(() => renderSpikeReport({ ...base, verdict: 'GO' as unknown as 'GO_AUTO' }), /INVALID_VERDICT/);
  assert.throws(() => renderSpikeReport({ ...base, platform: 'wechat', verdict: 'CONDITIONAL' }), /SNAPSHOT_PLATFORM_MISMATCH/);
});

test('notes and contract proposals are carried through when present', () => {
  const report = renderSpikeReport({ ...base, verdict: 'NO_GO', notes: '账号形态不符', contractProposals: ['需要新的来源更正事件'] });
  assert.ok(report.includes('补充说明：\n\n账号形态不符'));
  assert.ok(report.includes('- 需要新的来源更正事件'));
});
