// School records never persist in local/session storage as form drafts.
const drafts = new Map<string, { at: number; values: Record<string, unknown> }>();
let generation = 0;
// Async saves must not recreate private drafts after an account/school reset.
export function scopedDraft(key: string) {
  const captured = generation;
  return {
    isCurrent: () => generation === captured,
    read: () => (generation === captured ? readDraft(key) : {}),
    save: (values: Record<string, unknown>) => {
      if (generation === captured) saveDraft(key, values);
    },
    clear: () => {
      if (generation === captured) deleteDraft(key);
    },
  };
}
let suspended: { owner: string; values: typeof drafts } | undefined;
export function readDraft(key: string) {
  const item = drafts.get(key);
  if (!item || Date.now() - item.at > 3600000) {
    drafts.delete(key);
    return {};
  }
  return structuredClone(item.values);
}
export function saveDraft(key: string, values: Record<string, unknown>) {
  if (drafts.size >= 30 && !drafts.has(key)) drafts.delete(drafts.keys().next().value!);
  drafts.set(key, { at: Date.now(), values: structuredClone(values) });
}
export function deleteDraft(key: string) {
  drafts.delete(key);
}
// A failed refresh may remove the session before the login page mounts. Keep a
// private checkpoint that is released only after the same identity returns.
export function suspendDrafts(owner: string) {
  const values = structuredClone(drafts);
  if (suspended?.owner === owner) {
    for (const [key, value] of values) suspended.values.set(key, value);
  } else suspended = { owner, values };
}
export function resumeDrafts(owner: string) {
  const checkpoint = suspended;
  suspended = undefined;
  if (checkpoint?.owner !== owner) return;
  for (const [key, value] of checkpoint.values)
    if (Date.now() - value.at <= 3600000) drafts.set(key, value);
}
export function discardDraftCheckpoint() {
  suspended = undefined;
}
export function clearDrafts(preserveCheckpoint = false) {
  generation++;
  drafts.clear();
  if (!preserveCheckpoint) suspended = undefined;
}
