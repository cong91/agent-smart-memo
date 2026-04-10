// src/shared-contracts.ts
function buildTaggedSessionTitle(fields) {
  return [
    `${fields.taskId}`,
    `runId=${fields.runId}`,
    `taskId=${fields.taskId}`,
    `requested=${fields.requested}`,
    `resolved=${fields.resolved}`,
    `callbackSession=${fields.callbackSession}`,
    ...fields.callbackSessionId ? [`callbackSessionId=${fields.callbackSessionId}`] : [],
    ...fields.projectId ? [`projectId=${fields.projectId}`] : [],
    ...fields.repoRoot ? [`repoRoot=${fields.repoRoot}`] : []
  ].join(" ");
}
function parseTaggedSessionTitle(title) {
  if (!title || !title.trim()) return null;
  const tags = {};
  for (const token of title.split(/\s+/)) {
    const idx = token.indexOf("=");
    if (idx <= 0) continue;
    const key = token.slice(0, idx).trim();
    const raw = token.slice(idx + 1).trim();
    if (!key || !raw) continue;
    tags[key] = raw;
  }
  return Object.keys(tags).length > 0 ? tags : null;
}
function buildPluginCallbackDedupeKey(input) {
  return `${input.sessionId || "no-session"}|${input.runId || "no-run"}`;
}

export {
  buildTaggedSessionTitle,
  parseTaggedSessionTitle,
  buildPluginCallbackDedupeKey
};
