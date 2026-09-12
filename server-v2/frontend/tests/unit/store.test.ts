import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useEditor } from '../../src/store';
import { api } from '../../src/api';
vi.mock('../../src/api', () => ({
  api: {
    asset: vi.fn(async () => ({ id: 'a', name: 'image', width: 40, height: 30 })),
    save: vi.fn(),
  },
}));
beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', { setItem: vi.fn() });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function setup() {
  const s = useEditor();
  await s.open({
    id: 'project',
    revision: 0,
    updatedAt: 'now',
    name: 'Test',
    activeSceneId: 'scene',
    scenes: [
      {
        id: 'scene',
        name: 'Page 1',
        width: 100,
        height: 100,
        layers: [
          {
            id: 'l',
            assetId: 'a',
            name: 'Image',
            x: 0,
            y: 0,
            width: 40,
            height: 30,
            rotation: 0,
            flipX: false,
            flipY: false,
            opacity: 1,
            radius: 0,
            hidden: false,
            locked: false,
          },
        ],
      },
    ],
  });
  return s;
}
it('selection and views are not history; a mutation is one undo step', async () => {
  const s = await setup();
  s.select('l');
  expect(s.undoStack).toHaveLength(0);
  s.patch('l', { x: 20, y: 30 });
  expect(s.undoStack).toHaveLength(1);
  s.undo();
  expect(s.single?.x).toBe(0);
  s.undo(false);
  expect(s.single?.x).toBe(20);
});
it('save failure retains current data and history for explicit retry', async () => {
  const s = await setup();
  s.patch('l', { x: 7 });
  vi.mocked(api.save).mockRejectedValueOnce(new Error('磁盘失败'));
  await expect(s.save()).rejects.toThrow('磁盘失败');
  expect(s.dirty).toBe(true);
  expect(s.layers[0].x).toBe(7);
  expect(s.undoStack).toHaveLength(1);
  vi.mocked(api.save).mockResolvedValueOnce({ ...s.project!, revision: 1 });
  await s.save();
  expect(s.error).toBe('');
  expect(s.dirty).toBe(false);
  expect(s.project?.revision).toBe(1);
});
it('locked layers cannot be transformed or removed', async () => {
  const s = await setup();
  s.select('l');
  s.mutate(() => (s.layers[0].locked = true));
  s.patch('l', { x: 90 });
  s.remove();
  expect(s.layers).toHaveLength(1);
  expect(s.layers[0].x).toBe(0);
});
