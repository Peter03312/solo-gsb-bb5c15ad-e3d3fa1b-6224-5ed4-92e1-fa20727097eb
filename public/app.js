'use strict';

/* 字幕校订台前端：无框架，直接操作 DOM。 */

const $ = (sel) => document.querySelector(sel);

const state = {
  works: [],
  current: null, // { work, cues, dirty:Set<cueId> }
  editor: localStorage.getItem('srt-editor') || '',
};

$('#editor-name').value = state.editor;
$('#editor-name').addEventListener('input', (e) => {
  state.editor = e.target.value.trim();
  localStorage.setItem('srt-editor', state.editor);
});

/* ------------------------------------------------------------------ */
/* API 封装                                                            */
/* ------------------------------------------------------------------ */

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const err = new Error((data && data.message) || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data || {};
    throw err;
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* 上传                                                                */
/* ------------------------------------------------------------------ */

$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#upload-msg');
  msg.className = 'msg';
  msg.textContent = '读取文件中…';

  const title = $('#work-title').value.trim();
  const file = $('#srt-file').files[0];
  if (!title || !file) {
    msg.className = 'msg error';
    msg.textContent = '请填写标题并选择 .srt 文件';
    return;
  }

  let content;
  try {
    const buf = await file.arrayBuffer();
    // fatal: true 让非 UTF-8 字节直接报错，而不是静默变成替换符
    content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    msg.className = 'msg error';
    msg.textContent =
      '该文件不是合法 UTF-8 编码（读取到非法字节）。\n请用文本编辑器另存为 UTF-8 后重新上传。';
    return;
  }

  try {
    const r = await api('POST', '/api/works', {
      title,
      filename: file.name,
      content,
    });
    msg.className = 'msg ok';
    msg.textContent = `校验通过，已导入 ${r.cue_count} 段（修订号 ${r.revision}）`;
    $('#work-title').value = '';
    $('#srt-file').value = '';
    await loadWorks();
    await openWork(r.id);
  } catch (err) {
    msg.className = 'msg error';
    if (err.data && err.data.error === 'invalid_srt') {
      msg.textContent =
        `文件未通过校验，整份文件没有入库。\n第 ${err.data.line} 行：${err.data.message}`;
    } else {
      msg.textContent = err.message;
    }
  }
});

/* ------------------------------------------------------------------ */
/* 作品列表                                                            */
/* ------------------------------------------------------------------ */

async function loadWorks() {
  const r = await api('GET', '/api/works');
  state.works = r.works;
  const ul = $('#work-list');
  ul.innerHTML = '';

  if (state.works.length === 0) {
    const li = document.createElement('li');
    li.className = 's';
    li.textContent = '暂无作品';
    ul.appendChild(li);
    return;
  }

  for (const w of state.works) {
    const li = document.createElement('li');
    if (state.current && state.current.work.id === w.id) li.classList.add('active');

    const t = document.createElement('div');
    t.className = 't';
    t.textContent = w.title;
    const s = document.createElement('div');
    s.className = 's';
    s.textContent = `${w.cue_count} 段 · 修订 ${w.revision}`;
    li.append(t, s);
    li.addEventListener('click', () => openWork(w.id));
    ul.appendChild(li);
  }
}

$('#refresh-list').addEventListener('click', loadWorks);

/* ------------------------------------------------------------------ */
/* 打开作品、渲染字幕表                                                */
/* ------------------------------------------------------------------ */

async function openWork(id) {
  const r = await api('GET', `/api/works/${id}`);
  state.current = { work: r.work, cues: r.cues, dirty: new Set(), selected: new Set() };

  $('#empty-view').hidden = true;
  $('#work-view').hidden = false;
  $('#stale-banner').hidden = true;

  $('#work-title-display').textContent = r.work.title;
  $('#work-filename').textContent = r.work.filename;
  $('#work-revision').textContent = r.work.revision;
  $('#cue-count').textContent = r.cues.length;
  $('#work-updated').textContent = r.work.updated_at;
  $('#export-link').href = `/api/works/${id}/export`;

  resetShiftPanel();
  renderCues();
  await loadWorks();
}

function renderCues() {
  const tbody = $('#cue-tbody');
  tbody.innerHTML = '';

  for (const cue of state.current.cues) {
    const tr = document.createElement('tr');
    tr.dataset.cueId = cue.id;

    // 批量平移勾选
    const selTd = document.createElement('td');
    selTd.className = 'col-sel';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'cue-sel';
    cb.checked = state.current.selected.has(cue.id);
    cb.addEventListener('change', () => {
      if (cb.checked) state.current.selected.add(cue.id);
      else state.current.selected.delete(cue.id);
      updateShiftCount();
      invalidatePreview();
    });
    selTd.appendChild(cb);

    const idxTd = document.createElement('td');
    idxTd.className = 'col-idx';
    idxTd.textContent = cue.idx;

    // 开始时间
    const startTd = document.createElement('td');
    const startInput = document.createElement('input');
    startInput.type = 'text';
    startInput.value = cue.start;
    startInput.spellcheck = false;
    startInput.dataset.field = 'start';
    startTd.appendChild(startInput);

    // 结束时间
    const endTd = document.createElement('td');
    const endInput = document.createElement('input');
    endInput.type = 'text';
    endInput.value = cue.end;
    endInput.spellcheck = false;
    endInput.dataset.field = 'end';
    endTd.appendChild(endInput);

    // 文字（多行）
    const textTd = document.createElement('td');
    const ta = document.createElement('textarea');
    ta.value = cue.text;
    ta.rows = String(cue.text).split('\n').length;
    ta.dataset.field = 'text';
    ta.addEventListener('input', () => {
      ta.rows = Math.max(1, ta.value.split('\n').length);
      markDirty(tr, cue);
    });
    textTd.appendChild(ta);

    const rowMsg = document.createElement('span');
    rowMsg.className = 'row-msg';
    textTd.appendChild(rowMsg);

    // 保存
    const saveTd = document.createElement('td');
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', () =>
      saveCue(tr, cue, { startInput, endInput, ta, rowMsg, saveBtn })
    );
    saveTd.appendChild(saveBtn);

    const onEdit = () => markDirty(tr, cue);
    startInput.addEventListener('input', onEdit);
    endInput.addEventListener('input', onEdit);

    tr.append(selTd, idxTd, startTd, endTd, textTd, saveTd);
    tbody.appendChild(tr);
  }
}

function markDirty(tr, cue) {
  state.current.dirty.add(cue.id);
  tr.classList.add('edited');
}

function clearDirty(tr, cue) {
  state.current.dirty.delete(cue.id);
  tr.classList.remove('edited', 'row-err');
}

$('#reload-work').addEventListener('click', async () => {
  if (!state.current) return;
  if (
    state.current.dirty.size > 0 &&
    !confirm('有尚未保存的修改，重新载入将丢弃它们。确定继续？')
  ) {
    return;
  }
  await openWork(state.current.work.id);
});

$('#stale-reload').addEventListener('click', () => openWork(state.current.work.id));

$('#delete-work').addEventListener('click', async () => {
  if (!state.current) return;
  const { work } = state.current;
  if (!confirm(`确定删除作品「${work.title}」及其全部 ${state.current.cues.length} 条字幕？此操作不可撤销。`)) {
    return;
  }
  await api('DELETE', `/api/works/${work.id}`);
  state.current = null;
  $('#work-view').hidden = true;
  $('#empty-view').hidden = false;
  await loadWorks();
});

/* ------------------------------------------------------------------ */
/* 保存单条：携带修订号，处理 409                                      */
/* ------------------------------------------------------------------ */

async function saveCue(tr, cue, els) {
  const { startInput, endInput, ta, rowMsg, saveBtn } = els;
  rowMsg.className = 'row-msg';
  rowMsg.textContent = '';
  tr.classList.remove('row-err');

  const payload = {
    revision: state.current.work.revision,
    start: startInput.value.trim(),
    end: endInput.value.trim(),
    text: ta.value,
    editor: state.editor || null,
  };

  saveBtn.disabled = true;
  tr.classList.add('saving');
  try {
    const r = await api(
      'PUT',
      `/api/works/${state.current.work.id}/cues/${cue.id}`,
      payload
    );
    // 成功：更新本地修订号和该段基线
    state.current.work.revision = r.revision;
    Object.assign(cue, r.cue);
    startInput.value = r.cue.start;
    endInput.value = r.cue.end;
    ta.value = r.cue.text;
    ta.rows = Math.max(1, ta.value.split('\n').length);
    clearDirty(tr, cue);
    rowMsg.classList.add('ok');
    rowMsg.textContent = `已保存（修订号 ${r.revision}）`;
    $('#work-revision').textContent = r.revision;
    $('#stale-banner').hidden = true;
    invalidatePreview(); // 修订号已推进，旧的平移预览不能再用于确认
  } catch (err) {
    tr.classList.add('row-err');
    rowMsg.classList.add('error');

    if (err.status === 409 && err.data.error === 'revision_stale') {
      const latest = err.data.cue;
      // 更新全局最新修订号，供人工重试携带
      state.current.work.revision = err.data.latest_revision;
      $('#work-revision').textContent = err.data.latest_revision;
      $('#stale-rev').textContent = err.data.latest_revision;
      $('#stale-banner').hidden = false;

      rowMsg.innerHTML = '';
      const intro = document.createElement('div');
      intro.textContent =
        `修订号过期，已拒绝覆盖（最新修订号 ${err.data.latest_revision}）。` +
        '请对照下方服务器最新内容，人工合并后再保存：';
      const pre = document.createElement('pre');
      pre.className = 'latest-snapshot';
      pre.textContent =
        `${latest.start} --> ${latest.end}\n${latest.text}`;

      const useLatest = document.createElement('button');
      useLatest.className = 'linklike';
      useLatest.type = 'button';
      useLatest.textContent = '直接采用最新内容（放弃我这行的输入）';
      useLatest.addEventListener('click', () => {
        startInput.value = latest.start;
        endInput.value = latest.end;
        ta.value = latest.text;
        ta.rows = Math.max(1, ta.value.split('\n').length);
        Object.assign(cue, latest);
        clearDirty(tr, cue);
        rowMsg.className = 'row-msg';
        rowMsg.textContent = '已填入最新版本；如仍需调整可直接修改后保存。';
      });

      rowMsg.append(intro, pre, useLatest);
    } else {
      rowMsg.textContent = err.message;
    }
  } finally {
    saveBtn.disabled = false;
    tr.classList.remove('saving');
  }
}

/* ------------------------------------------------------------------ */
/* 批量平移：选段 -> 预览 -> 应用                                       */
/* ------------------------------------------------------------------ */

const shiftState = { preview: null }; // 最近一次预览结果（确认时携带其修订号）

function shiftSelectedIds() {
  return state.current ? [...state.current.selected] : [];
}

function invalidatePreview() {
  shiftState.preview = null;
  $('#shift-result').innerHTML = '';
  $('#shift-apply').disabled = true;
}

function updateShiftCount() {
  $('#shift-count').textContent = state.current ? state.current.selected.size : 0;
}

function resetShiftPanel() {
  invalidatePreview();
  $('#shift-offset').value = '';
  const msg = $('#shift-msg');
  msg.className = 'msg';
  msg.textContent = '';
  updateShiftCount();
}

/** 严格解析有符号整数毫秒；非法返回 null */
function parseOffsetInput() {
  const raw = $('#shift-offset').value.trim();
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function setAllSelected(on) {
  if (!state.current) return;
  state.current.selected = on ? new Set(state.current.cues.map((c) => c.id)) : new Set();
  document.querySelectorAll('#cue-tbody .cue-sel').forEach((cb) => {
    cb.checked = on;
  });
  updateShiftCount();
  invalidatePreview();
}

$('#shift-select-all').addEventListener('click', () => setAllSelected(true));
$('#shift-clear').addEventListener('click', () => setAllSelected(false));
$('#shift-offset').addEventListener('input', invalidatePreview);

function renderShiftResult(p) {
  const box = $('#shift-result');
  box.innerHTML = '';

  const head = document.createElement('p');
  head.className = `shift-summary ${p.ok ? 'ok' : 'bad'}`;
  head.textContent = p.ok
    ? `依据修订号 ${p.revision}：${p.items.length} 段可整体平移，无碰撞。确认应用将携带该修订号。`
    : `依据修订号 ${p.revision}：${p.problems.map((x) => x.message).join('；')}，无法应用。`;
  box.appendChild(head);

  const table = document.createElement('table');
  table.className = 'shift-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>段</th><th>调整前</th><th>调整后</th><th>碰撞对象</th></tr>';
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const item of p.items) {
    const tr = document.createElement('tr');
    if (item.negative_start || item.collisions.length > 0) tr.classList.add('shift-bad');

    const idx = document.createElement('td');
    idx.textContent = `第 ${item.idx} 段`;

    const before = document.createElement('td');
    before.textContent = `${item.before.start} → ${item.before.end}`;

    const after = document.createElement('td');
    after.textContent =
      `${item.after.start} → ${item.after.end}` + (item.negative_start ? '（起点为负）' : '');

    const coll = document.createElement('td');
    coll.textContent =
      item.collisions.length === 0
        ? '—'
        : item.collisions
            .map((c) => `第 ${c.idx} 段 ${c.start}–${c.end}${c.selected ? '（同批）' : ''}`)
            .join('；');

    tr.append(idx, before, after, coll);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);

  $('#shift-apply').disabled = !p.ok;
}

$('#shift-preview').addEventListener('click', async () => {
  const msg = $('#shift-msg');
  msg.className = 'msg';
  msg.textContent = '';
  if (!state.current) return;

  const ids = shiftSelectedIds();
  if (ids.length === 0) {
    msg.classList.add('error');
    msg.textContent = '请先勾选要平移的字幕段';
    return;
  }
  const offset = parseOffsetInput();
  if (offset === null) {
    msg.classList.add('error');
    msg.textContent = '偏移量必须是有符号整数毫秒（如 -500 或 2000）';
    return;
  }

  try {
    const p = await api('POST', `/api/works/${state.current.work.id}/shift/preview`, {
      cue_ids: ids,
      offset_ms: offset,
    });
    shiftState.preview = p;
    renderShiftResult(p);
  } catch (err) {
    invalidatePreview();
    msg.classList.add('error');
    msg.textContent = err.message;
  }
});

$('#shift-apply').addEventListener('click', async () => {
  const p = shiftState.preview;
  const msg = $('#shift-msg');
  if (!state.current || !p || !p.ok) return;
  msg.className = 'msg';
  msg.textContent = '';

  const workId = state.current.work.id;
  try {
    const r = await api('POST', `/api/works/${workId}/shift`, {
      cue_ids: shiftSelectedIds(),
      offset_ms: p.offset_ms,
      revision: p.revision, // 预览所依据的修订号
      editor: state.editor || null,
    });
    await openWork(workId);
    const done = $('#shift-msg');
    done.className = 'msg ok';
    done.textContent = `已平移 ${r.shifted} 段（新修订号 ${r.revision}），展示序号已重排。`;
  } catch (err) {
    msg.classList.add('error');
    if (err.status === 409 && err.data.error === 'revision_stale') {
      // 作品已被他人改动：未按过期预览写入，提示重新载入
      state.current.work.revision = err.data.latest_revision;
      $('#work-revision').textContent = err.data.latest_revision;
      $('#stale-rev').textContent = err.data.latest_revision;
      $('#stale-banner').hidden = false;
      invalidatePreview();
      msg.textContent =
        `作品已被他人修改（最新修订号 ${err.data.latest_revision}），本次未写入。` +
        '请重新载入后重新预览。';
    } else if (err.status === 422) {
      invalidatePreview();
      msg.textContent = `${err.message}。可调整选择或偏移量后重新预览。`;
    } else {
      msg.textContent = err.message;
    }
  }
});

/* ------------------------------------------------------------------ */
/* 离开页面前提醒未保存修改                                            */
/* ------------------------------------------------------------------ */

window.addEventListener('beforeunload', (e) => {
  if (state.current && state.current.dirty.size > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* 初始化 */
loadWorks().catch((err) => {
  const ul = $('#work-list');
  ul.innerHTML = '';
  const li = document.createElement('li');
  li.className = 's';
  li.textContent = `加载失败：${err.message}`;
  ul.appendChild(li);
});
