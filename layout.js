// Presentation preferences belong to the family, not a particular version.
export function orderedFamilies(data) {
  const layout = data.settings.skillLayout || {};
  const pinned = new Set(layout.pinned || []);
  const positions = new Map((layout.order || []).map((id, i) => [id, i]));
  const dates = new Map(data.versions.map(v => [v.versionId, v.savedAt]));
  return [...data.families].sort((a, b) => {
    const group = Number(pinned.has(b.familyId)) - Number(pinned.has(a.familyId));
    if (group) return group;
    const ai = positions.get(a.familyId), bi = positions.get(b.familyId);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return 1; // New skills precede manually ordered ones.
    if (bi !== undefined) return -1;
    return (dates.get(b.currentVersionId) || b.updatedAt).localeCompare(dates.get(a.currentVersionId) || a.updatedAt) || a.familyId.localeCompare(b.familyId);
  });
}
function currentLayout(data) {
  const families = orderedFamilies(data);
  const ids = new Set(families.map(f => f.familyId));
  return {order: families.map(f => f.familyId), pinned: (data.settings.skillLayout?.pinned || []).filter(id => ids.has(id))};
}
export function pinLayout(data, id) {
  const layout = currentLayout(data);
  if (!layout.order.includes(id)) throw new Error('Skillが見つかりません');
  layout.pinned = layout.pinned.includes(id) ? layout.pinned.filter(value => value !== id) : [...layout.pinned, id];
  return layout;
}
export function moveLayout(data, id, direction, visibleIds) {
  if (![-1, 1].includes(direction)) throw new Error('移動方向が不正です');
  const layout = currentLayout(data);
  const pinned = new Set(layout.pinned), visible = new Set(visibleIds);
  const group = layout.order.filter(value => visible.has(value) && pinned.has(value) === pinned.has(id));
  const position = group.indexOf(id), neighbor = group[position + direction];
  if (position < 0 || !neighbor) throw new Error('この方向には移動できません');
  const a = layout.order.indexOf(id), b = layout.order.indexOf(neighbor);
  [layout.order[a], layout.order[b]] = [layout.order[b], layout.order[a]];
  return layout;
}
