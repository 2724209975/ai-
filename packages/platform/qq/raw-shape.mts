/** Shape-only diagnostic for one stored raw platform event.
 *
 * Runbook step 5 needs to know whether `message_sent` carries a stable peer field, but reports may
 * not contain chat bodies, peer numbers, URLs or reversible hashes. This describes the structure
 * only: key names, presence flags, segment kinds and byte length. Protocol enum values are echoed
 * only from a fixed allowlist, so an attacker-controlled string can never reach a report.
 */
const POST_TYPES = ['message', 'message_sent', 'notice', 'request', 'meta_event'] as const;
const MESSAGE_TYPES = ['private', 'group'] as const;
const SUB_TYPES = ['friend', 'group', 'normal', 'anonymous', 'other'] as const;
const NOTICE_TYPES = ['friend_recall', 'group_recall', 'group_admin', 'group_upload', 'notify', 'other'] as const;
const SEGMENT_TYPES = ['text', 'image', 'record', 'face', 'reply', 'at', 'file', 'json', 'xml', 'markdown', 'forward', 'video', 'other'] as const;

export type RawShape = {
  redacted: true;
  byteLength?: number;
  topLevelKeys: string[];
  postType: (typeof POST_TYPES)[number] | 'other' | 'absent';
  messageType: (typeof MESSAGE_TYPES)[number] | 'other' | 'absent';
  subType: (typeof SUB_TYPES)[number] | 'other' | 'absent';
  noticeType: (typeof NOTICE_TYPES)[number] | 'other' | 'absent';
  present: { selfId: boolean; userId: boolean; targetId: boolean; groupId: boolean; messageId: boolean; time: boolean; sender: boolean; message: boolean };
  /** Equality only; never expose an identifier or treat this as owner-origin proof. */
  idRelations: { userToSelf: 'same' | 'different' | 'unavailable'; targetToSelf: 'same' | 'different' | 'unavailable';
    userToTarget: 'same' | 'different' | 'unavailable'; senderToSelf: 'same' | 'different' | 'unavailable' };
  senderKeys: string[];
  messageArray: boolean;
  segmentCount: number;
  segmentTypes: (typeof SEGMENT_TYPES)[number][];
  /** Segment data key names only - never their values, which may hold text or media references. */
  segmentDataKeys: string[][];
  notes: string[];
};

function allowed<T extends readonly string[]>(list: T, value: unknown): T[number] | 'other' | 'absent' {
  if (value === undefined || value === null || value === '') return 'absent';
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T[number]) : 'other';
}
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function compareIds(a: unknown, b: unknown): 'same' | 'different' | 'unavailable' {
  const normalize = (value: unknown): string | undefined => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) > 0n) return BigInt(value).toString();
    return undefined;
  };
  const left = normalize(a), right = normalize(b);
  return left === undefined || right === undefined ? 'unavailable' : left === right ? 'same' : 'different';
}

export function describeRawShape(input: unknown, options: { byteLength?: number } = {}): RawShape {
  const event = isObject(input) ? input : {};
  const message = Array.isArray(event.message) ? event.message : [];
  const sender = isObject(event.sender) ? event.sender : undefined;
  const segmentTypes: RawShape['segmentTypes'] = [];
  const segmentDataKeys: string[][] = [];
  for (const segment of message) {
    const record = isObject(segment) ? segment : {};
    segmentTypes.push(allowed(SEGMENT_TYPES, record.type) === 'absent' ? 'other' : allowed(SEGMENT_TYPES, record.type) as RawShape['segmentTypes'][number]);
    const data = isObject(record.data) ? record.data : {};
    segmentDataKeys.push(Object.keys(data).sort());
  }
  const notes: string[] = [];
  if (allowed(POST_TYPES, event.post_type) === 'message_sent') {
    notes.push('message_sent：对端字段需与 message/notice 事件对照后才能确定映射，未确认前不得据 target/user 字段猜联系人');
  }
  if (event.user_id !== undefined && event.target_id !== undefined) notes.push('同时存在 user_id 与 target_id：两者语义需实测区分，不能按名字推断');
  if (!segmentTypes.length) notes.push('消息段为空或不是数组：可能是不支持的格式，不能推断为纯文本');
  if (segmentTypes.some(type => ['image', 'record', 'video', 'forward'].includes(type))) notes.push('含媒体段：完整性与动画状态需另行验证，不能按单帧或缩略图记 complete');
  return { redacted: true, ...(options.byteLength === undefined ? {} : { byteLength: options.byteLength }),
    topLevelKeys: Object.keys(event).sort(),
    postType: allowed(POST_TYPES, event.post_type), messageType: allowed(MESSAGE_TYPES, event.message_type),
    subType: allowed(SUB_TYPES, event.sub_type), noticeType: allowed(NOTICE_TYPES, event.notice_type),
    present: { selfId: event.self_id !== undefined, userId: event.user_id !== undefined, targetId: event.target_id !== undefined,
      groupId: event.group_id !== undefined, messageId: event.message_id !== undefined, time: event.time !== undefined,
      sender: sender !== undefined, message: event.message !== undefined },
    idRelations: { userToSelf: compareIds(event.user_id, event.self_id), targetToSelf: compareIds(event.target_id, event.self_id),
      userToTarget: compareIds(event.user_id, event.target_id), senderToSelf: compareIds(sender?.user_id, event.self_id) },
    senderKeys: sender ? Object.keys(sender).sort() : [], messageArray: Array.isArray(event.message),
    segmentCount: message.length, segmentTypes, segmentDataKeys, notes };
}
