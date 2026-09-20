/* global document, location, window, MouseEvent */

export async function verifyResonanceScenes(evaluate) {
  const evaluation = await evaluate(`(${sceneFlow.toString()})()`, true);
  if (evaluation?.exceptionDetails) throw new Error(`Resonance scenes failed: ${JSON.stringify(evaluation.exceptionDetails)}`);
  const result = evaluation?.result?.value;
  if (!result?.id || result.videoCount !== 1) throw new Error(`Resonance scene result invalid: ${JSON.stringify(result)}`);

  await evaluate('location.reload(); true', false);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await evaluate('Boolean(document.querySelector(".resonance-ball"))', false);
    if (ready?.result?.value) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const restored = await evaluate(`(async () => {
    document.querySelector('.resonance-ball')?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      id: document.querySelector('#resonance-scene-select')?.value,
      videoCount: document.querySelectorAll('.resonance-tile').length,
      selected: document.querySelector('#resonance-scene-select option:checked')?.textContent,
      dialogOpen: [...document.querySelectorAll('.resonance-scene-dialog')].some((element) => element.getClientRects().length),
    };
  })()`, true);
  const state = restored?.result?.value;
  if (state?.id !== result.id || state.videoCount !== 1 || !state.selected.includes('Smoke 场景 A') || state.dialogOpen) {
    throw new Error(`Resonance scene restore failed: ${JSON.stringify(state)}`);
  }
  console.log('RESONANCE_SCENES_OK save=ok copy=ok switch=ok rename=ok delete=ok reload=ok');
}

async function sceneFlow() {
  const delay = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  async function waitFor(read) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const result = read();
      if (result) return result;
      await delay();
    }
    throw new Error('Scene UI did not become ready');
  }
  const button = (root, label) => [...root.querySelectorAll('button')].find((item) => item.textContent.trim() === label);
  const read = () => JSON.parse(window.localStorage.getItem('local-film-library:resonance-scenes-v1') ?? '{}');
  async function confirmName(name) {
    const input = await waitFor(() => document.querySelector('#resonance-scene-name'));
    input.value = name;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await delay();
    document.querySelector('.scene-confirm').click();
    await delay(350);
  }
  async function manage(name, action) {
    document.querySelector('.scene-manage').click();
    const row = await waitFor(() => [...document.querySelectorAll('.scene-row')].find((item) => item.querySelector('strong')?.textContent === name));
    button(row, action).click();
    await delay();
  }
  async function select(id) {
    const element = document.querySelector('#resonance-scene-select');
    element.value = id;
    element.dispatchEvent(new Event('change', { bubbles: true }));
    await delay();
    assert(read().activeSceneId === id, 'Scene selection was not persisted');
  }

  location.hash = '#/library?resonance-smoke=1';
  const card = await waitFor(() => document.querySelector('.film-card'));
  card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const add = await waitFor(() => button(document, '添加进共鸣球'));
  add.click();
  await delay();
  document.querySelector('.resonance-ball').click();
  await waitFor(() => document.querySelector('.resonance-tile'));
  document.querySelector('.scene-save-as').click();
  await confirmName('Smoke 场景 A');
  const saved = read();
  assert(saved.scenes.length === 1 && saved.scenes[0].videos.length === 1, 'Scene save did not retain the video');
  const firstId = saved.activeSceneId;

  await manage('Smoke 场景 A', '复制');
  await confirmName('Smoke 场景 B');
  const copy = read().scenes.find((scene) => scene.name === 'Smoke 场景 B');
  assert(copy && copy.id !== firstId && read().activeSceneId === firstId, 'Copy changed the active scene');
  const previousPlayer = document.querySelector('.resonance-tile video');
  await select(copy.id);
  assert(document.querySelector('.resonance-tile video') !== previousPlayer, 'Switch reused the old player for the same file');
  assert(document.querySelector('.resonance-tile video').paused, 'Switch unexpectedly started playback');
  await manage('Smoke 场景 B', '重命名');
  await confirmName('Smoke 场景 B 改名');
  assert(read().scenes.find((scene) => scene.id === copy.id)?.name === 'Smoke 场景 B 改名', 'Rename failed');

  await select(firstId);
  await manage('Smoke 场景 B 改名', '删除');
  document.querySelector('.scene-confirm').click();
  await delay(350);
  assert(read().scenes.length === 1 && read().activeSceneId === firstId, 'Delete affected another scene');
  return { id: firstId, videoCount: read().scenes[0].videos.length };
}
