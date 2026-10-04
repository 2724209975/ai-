/** Synthetic output only; no database, account, platform or model connection. */
process.stdout.write(JSON.stringify({ event: 'media_model_call', mediaType: 'image', outcome: 'ok',
  callId: '00000000-0000-4000-8000-000000000001', contextSnapshotId: '00000000-0000-4000-8000-000000000002',
  inputTokens: 12, outputTokens: 3, elapsedMs: 45, text: 'PRIVATE_BODY' }) + '\n');
setInterval(() => {}, 1000);
