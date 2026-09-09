import { mount } from '@vue/test-utils';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import SliceRegenerationReview from '../../src/ui/components/SliceRegenerationReview.vue';
import type { RegenerationSnapshot } from '../../src/ui/types/regeneration';
const snapshot = (): RegenerationSnapshot => ({ items: [{ id: 'p', name: '探索民宿', dataUrl: 'before', width: 220, height: 80, childCount: 1, status: 'pending' }], provider: '远程 API · model', running: false, saving: false, confirmed: false });
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });
test('preflight has one explicit paid generation action, safe text and no auto-start', async () => {
  const wrapper = mount(SliceRegenerationReview, { props: { snapshot: snapshot() }, attachTo: document.body });
  expect(wrapper.emitted('action')).toBeUndefined();
  expect(wrapper.text()).toContain('可能产生费用');
  const start = wrapper.findAll('button').find(b => b.text() === '确认并开始生成')!;
  await start.trigger('click');
  expect(wrapper.emitted('action')?.[0]).toEqual([{ type: 'start', id: 'p' }]);
  wrapper.unmount();
});
test('ready candidates only apply explicitly, while running and saving are locked', async () => {
  const state = snapshot(); state.confirmed = true;
  state.items[0]!.status = 'ready'; state.items[0]!.result = { dataUrl: 'after', width: 440, height: 160, provider: { model: 'remote' } };
  const wrapper = mount(SliceRegenerationReview, { props: { snapshot: state } });
  const apply = () => wrapper.findAll('button').find(b => b.text() === '应用此图')!;
  await wrapper.setProps({ snapshot: { ...state, running: true } }); expect(apply().attributes('disabled')).toBeDefined();
  await wrapper.setProps({ snapshot: { ...state, saving: true } }); expect(apply().attributes('disabled')).toBeDefined();
  await wrapper.setProps({ snapshot: state }); await apply().trigger('click');
  expect(wrapper.emitted('action')?.[0]).toEqual([{ type: 'apply', id: 'p' }]);
  expect(wrapper.text()).toContain('440 × 160'); wrapper.unmount();
});
test('close returns focus and Escape requests guarded close', async () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const wrapper = mount(SliceRegenerationReview, { props: { snapshot: snapshot() }, attachTo: document.body });
  await wrapper.find('dialog').trigger('cancel');
  expect(wrapper.emitted('action')?.[0]).toEqual([{ type: 'close', id: 'p' }]);
  wrapper.unmount(); expect(document.activeElement).toBe(opener);
});
