const RouteManager = require('../src/proxy/route-manager');
const { detectPortConflicts } = RouteManager;

const R = (id, localPort) => ({ id, localPort });

describe('detectPortConflicts — 埠衝突偵測（純函式，applyRoutes 共用）', () => {
  test('無衝突 → 全部 clear', () => {
    const { clear, conflicts } = detectPortConflicts([R('a', 10810), R('b', 10811)], []);
    expect(clear.map(r => r.id)).toEqual(['a', 'b']);
    expect(conflicts).toEqual([]);
  });

  test('兩條同埠 → 第二條標 duplicate（指向第一條），第一條仍 clear', () => {
    const { clear, conflicts } = detectPortConflicts([R('a', 10810), R('b', 10810)], []);
    expect(clear.map(r => r.id)).toEqual(['a']);
    expect(conflicts).toEqual([{ id: 'b', port: 10810, reason: 'duplicate', with: 'a' }]);
  });

  test('埠等於主連線埠 → primary 衝突、不 clear', () => {
    const { clear, conflicts } = detectPortConflicts([R('a', 10808)], [10808, 10809]);
    expect(clear).toEqual([]);
    expect(conflicts).toEqual([{ id: 'a', port: 10808, reason: 'primary' }]);
  });

  test('primary 優先於 duplicate（兩條都撞主連線 → 都是 primary，不互記重複）', () => {
    const { clear, conflicts } = detectPortConflicts([R('a', 10808), R('b', 10808)], [10808]);
    expect(clear).toEqual([]);
    expect(conflicts).toEqual([
      { id: 'a', port: 10808, reason: 'primary' },
      { id: 'b', port: 10808, reason: 'primary' },
    ]);
  });

  test('混合：a/d clear、b 撞主連線、c 與 a 重複', () => {
    const { clear, conflicts } = detectPortConflicts(
      [R('a', 10810), R('b', 10809), R('c', 10810), R('d', 10811)], [10808, 10809]);
    expect(clear.map(r => r.id)).toEqual(['a', 'd']);
    expect(conflicts).toEqual([
      { id: 'b', port: 10809, reason: 'primary' },
      { id: 'c', port: 10810, reason: 'duplicate', with: 'a' },
    ]);
  });

  test('主連線未開（primaryPorts 空）→ 只查路由間重複', () => {
    const { clear, conflicts } = detectPortConflicts([R('a', 10808), R('b', 10808)], []);
    expect(clear.map(r => r.id)).toEqual(['a']);
    expect(conflicts).toEqual([{ id: 'b', port: 10808, reason: 'duplicate', with: 'a' }]);
  });

  test('三條同埠 → 後兩條都 duplicate 指向第一條', () => {
    const { conflicts } = detectPortConflicts([R('a', 9), R('b', 9), R('c', 9)], []);
    expect(conflicts).toEqual([
      { id: 'b', port: 9, reason: 'duplicate', with: 'a' },
      { id: 'c', port: 9, reason: 'duplicate', with: 'a' },
    ]);
  });

  test('空清單 → 空結果（不炸）', () => {
    expect(detectPortConflicts([], [10808])).toEqual({ clear: [], conflicts: [] });
  });
});
