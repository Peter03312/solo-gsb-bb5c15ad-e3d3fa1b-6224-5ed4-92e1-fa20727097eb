'use strict';

/**
 * 多人字幕校订 HTTP 服务。
 *
 * 并发模型：每次编辑携带作品修订号（乐观锁）。
 * 过期提交 -> 409，并返回最新修订号与目标字幕段，供前端人工重试。
 */

const path = require('path');
const express = require('express');
const { openDb } = require('./db');
const {
  SrtError,
  parseSrt,
  parseTimeToMs,
  formatMs,
  serializeSrt,
} = require('./srt');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'subtitles.db');
const MAX_TEXT_LEN = 10000;
const MAX_TITLE_LEN = 200;

// sql.js 需要先加载 wasm，所有请求处理都会 await 此 promise
const dbReady = openDb(DB_PATH).then((instance) => {
  db = instance;
  /** 按开始时间重排作品内全部字幕段的展示序号 */
  reindexCues = db.transaction((workId) => {
    const rows = db
      .prepare('SELECT id FROM cues WHERE work_id = ? ORDER BY start_ms, end_ms, id')
      .all(workId);
    const stmt = db.prepare('UPDATE cues SET idx = ? WHERE id = ?');
    rows.forEach((r, i) => stmt.run(i + 1, r.id));
  });
  return db;
});
let db;
let reindexCues;
const app = express();

app.use(async (req, res, next) => {
  try {
    await dbReady;
    next();
  } catch (err) {
    next(err);
  }
});
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function cueRow(row) {
  return {
    id: row.id,
    idx: row.idx,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    start: formatMs(row.start_ms),
    end: formatMs(row.end_ms),
    text: row.text,
  };
}

function getWorkOr404(workId) {
  const work = db.prepare('SELECT * FROM works WHERE id = ?').get(workId);
  if (!work) throw new HttpError(404, 'not_found', '作品不存在');
  return work;
}

function normalizeText(text) {
  if (typeof text !== 'string') {
    throw new HttpError(400, 'invalid_text', '字幕文字必须是字符串');
  }
  const t = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (t.trim() === '') {
    throw new HttpError(400, 'invalid_text', '字幕文字不能为空');
  }
  if (t.length > MAX_TEXT_LEN) {
    throw new HttpError(400, 'invalid_text', `字幕文字过长（上限 ${MAX_TEXT_LEN} 字）`);
  }
  return t;
}

/** 有符号毫秒 -> 时间码；负数带前导负号（批量平移预览/报错展示用） */
function formatSignedMs(ms) {
  return ms < 0 ? `-${formatMs(-ms)}` : formatMs(ms);
}

/**
 * 解析批量平移的公共参数：
 *   cue_ids   非空、正整数、不重复的字幕段标识数组
 *   offset_ms 有符号整数毫秒偏移量
 * 任何一项非法都抛 400，与作品数据无关，进事务前先挡住。
 */
function parseShiftParams(body) {
  const { cue_ids: cueIds, offset_ms: offsetMs } = body || {};

  if (!Array.isArray(cueIds) || cueIds.length === 0) {
    throw new HttpError(400, 'empty_selection', '请至少选择一个要平移的字幕段');
  }
  if (cueIds.some((id) => !Number.isInteger(id) || id < 1)) {
    throw new HttpError(400, 'invalid_cue_ids', '字幕段标识必须为正整数数组');
  }
  const seen = new Set();
  const duplicates = new Set();
  for (const id of cueIds) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw new HttpError(400, 'duplicate_cues', '选择中存在重复的字幕段', {
      duplicates: [...duplicates],
    });
  }
  if (!Number.isSafeInteger(offsetMs)) {
    throw new HttpError(
      400,
      'invalid_offset',
      '偏移量必须是有符号整数毫秒（如 -500 或 2000）'
    );
  }
  return { cueIds, offsetMs };
}

/** 选中段必须全部属于该作品（在同事务已加载的全量段上核对） */
function assertCuesExist(allCues, cueIds) {
  const found = new Set(allCues.map((c) => c.id));
  const missing = cueIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new HttpError(
      404,
      'cue_not_found',
      `字幕段不存在或不属于该作品：${missing.join(', ')}`,
      { missing }
    );
  }
}

/**
 * 平移方案（纯计算，预览与确认共用）：
 * 选中段整体加 offsetMs，未选段不动；在半开区间语义下（首尾相接允许）检查
 *   1) 选中段新起点为负；
 *   2) 调整后全部段两两交叠（选中段彼此、选中与未选都覆盖）。
 * 返回每段调整前后时间、碰撞对象，以及整批违例汇总。
 */
function computeShiftPlan(allCues, cueIds, offsetMs) {
  const selected = new Set(cueIds);
  const byId = new Map(allCues.map((c) => [c.id, c]));

  const arranged = allCues
    .map((c) => ({
      id: c.id,
      idx: c.idx,
      selected: selected.has(c.id),
      start_ms: selected.has(c.id) ? c.start_ms + offsetMs : c.start_ms,
      end_ms: selected.has(c.id) ? c.end_ms + offsetMs : c.end_ms,
    }))
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.id - b.id);

  const cueView = (c) => ({
    cue_id: c.id,
    idx: c.idx,
    selected: c.selected,
    start_ms: c.start_ms,
    end_ms: c.end_ms,
    start: formatSignedMs(c.start_ms),
    end: formatSignedMs(c.end_ms),
  });

  // 扫描线找全部交叠对（半开区间：前一段结束 == 后一段开始 不算交叠）
  const pairs = [];
  const active = [];
  for (const cur of arranged) {
    for (let k = active.length - 1; k >= 0; k--) {
      if (active[k].end_ms <= cur.start_ms) active.splice(k, 1);
    }
    for (const prev of active) pairs.push({ a: cueView(prev), b: cueView(cur) });
    active.push(cur);
  }

  const collisionsOf = new Map();
  for (const { a, b } of pairs) {
    if (!collisionsOf.has(a.cue_id)) collisionsOf.set(a.cue_id, []);
    if (!collisionsOf.has(b.cue_id)) collisionsOf.set(b.cue_id, []);
    collisionsOf.get(a.cue_id).push(b);
    collisionsOf.get(b.cue_id).push(a);
  }

  const negative = arranged.filter((c) => c.selected && c.start_ms < 0).map(cueView);

  const items = arranged
    .filter((c) => c.selected)
    .map((c) => {
      const orig = byId.get(c.id);
      return {
        cue_id: c.id,
        idx: c.idx,
        before: {
          start_ms: orig.start_ms,
          end_ms: orig.end_ms,
          start: formatMs(orig.start_ms),
          end: formatMs(orig.end_ms),
        },
        after: {
          start_ms: c.start_ms,
          end_ms: c.end_ms,
          start: formatSignedMs(c.start_ms),
          end: formatSignedMs(c.end_ms),
        },
        negative_start: c.start_ms < 0,
        collisions: collisionsOf.get(c.id) || [],
      };
    });

  return { ok: negative.length === 0 && pairs.length === 0, items, negative, pairs };
}

/** 把方案里的违例汇总成 problems 列表（预览响应与 422 报错共用结构） */
function shiftProblems(plan) {
  const problems = [];
  if (plan.negative.length > 0) {
    problems.push({
      code: 'negative_start',
      message: `平移后 ${plan.negative.length} 个字幕段的开始时间为负`,
      cues: plan.negative,
    });
  }
  if (plan.pairs.length > 0) {
    problems.push({
      code: 'overlap',
      message: `平移后存在 ${plan.pairs.length} 处字幕段时间交叠`,
      pairs: plan.pairs,
    });
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* 作品：列表 / 详情 / 删除                                            */
/* ------------------------------------------------------------------ */

app.get('/api/works', (req, res) => {
  const works = db
    .prepare(
      `SELECT w.id, w.title, w.filename, w.revision, w.created_at, w.updated_at,
              COUNT(c.id) AS cue_count
         FROM works w
         LEFT JOIN cues c ON c.work_id = w.id
        GROUP BY w.id
        ORDER BY w.updated_at DESC, w.id DESC`
    )
    .all();
  res.json({ works });
});

app.get('/api/works/:id', (req, res, next) => {
  try {
    const work = getWorkOr404(req.params.id);
    const cues = db
      .prepare('SELECT * FROM cues WHERE work_id = ? ORDER BY idx, id')
      .all(work.id)
      .map(cueRow);
    res.json({
      work: {
        id: work.id,
        title: work.title,
        filename: work.filename,
        revision: work.revision,
        created_at: work.created_at,
        updated_at: work.updated_at,
      },
      cues,
    });
  } catch (e) {
    next(e);
  }
});

app.delete('/api/works/:id', (req, res, next) => {
  try {
    const work = getWorkOr404(req.params.id);
    db.prepare('DELETE FROM works WHERE id = ?').run(work.id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 上传：严格校验，任何错误整份不入库                                  */
/* ------------------------------------------------------------------ */

app.post('/api/works', (req, res, next) => {
  try {
    const { title, filename, content } = req.body || {};

    if (typeof title !== 'string' || !title.trim()) {
      throw new HttpError(400, 'invalid_title', '作品标题不能为空');
    }
    if (title.trim().length > MAX_TITLE_LEN) {
      throw new HttpError(400, 'invalid_title', `标题过长（上限 ${MAX_TITLE_LEN} 字）`);
    }
    if (typeof filename !== 'string' || !filename.trim()) {
      throw new HttpError(400, 'invalid_filename', '缺少原始文件名');
    }
    if (typeof content !== 'string' || content.length === 0) {
      throw new HttpError(400, 'invalid_content', '缺少 SRT 文件内容');
    }
    if (content.includes('�')) {
      // 前端按 UTF-8 解码后仍出现替换符，基本可判定编码不对
      throw new SrtError('文件疑似不是 UTF-8 编码，请另存为 UTF-8 后重新上传', 1);
    }

    // 解析 + 时间合法性 + 交叠检查；抛错则下面的 catch 直接返回，绝不入库
    const parsed = parseSrt(content);

    const result = db.transaction(() => {
      const info = db
        .prepare('INSERT INTO works (title, filename) VALUES (?, ?)')
        .run(title.trim(), filename.trim());
      const workId = info.lastInsertRowid;

      const insertCue = db.prepare(
        'INSERT INTO cues (work_id, idx, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)'
      );
      parsed
        .slice()
        .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)
        .forEach((c, i) => {
          insertCue.run(workId, i + 1, c.start_ms, c.end_ms, c.text);
        });

      db.prepare(
        'INSERT INTO revisions_log (work_id, revision, action) VALUES (?, 1, ?)'
      ).run(workId, 'import');

      return workId;
    })();

    res.status(201).json({ id: result, revision: 1, cue_count: parsed.length });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 编辑单条字幕：乐观锁 + 时间合法性 + 交叠检查                        */
/* ------------------------------------------------------------------ */

app.put('/api/works/:id/cues/:cueId', (req, res, next) => {
  try {
    const workId = Number(req.params.id);
    const cueId = Number(req.params.cueId);
    const { revision, editor } = req.body || {};

    const work = getWorkOr404(workId);

    if (!Number.isInteger(revision) || revision < 1) {
      throw new HttpError(400, 'invalid_revision', '缺少有效的作品修订号');
    }

    const text = normalizeText(req.body && req.body.text);

    const startMs = parseTimeToMs(String(req.body.start ?? ''));
    const endMs = parseTimeToMs(String(req.body.end ?? ''));
    if (startMs === null || endMs === null) {
      throw new HttpError(
        400,
        'invalid_time',
        '时间格式应为 HH:MM:SS,mmm（例如 00:01:23,500）'
      );
    }
    if (startMs < 0 || endMs < 0) {
      throw new HttpError(422, 'negative_time', '时间不能为负数');
    }
    if (endMs <= startMs) {
      throw new HttpError(422, 'invalid_range', '结束时间必须晚于开始时间');
    }

    const outcome = db
      .transaction((wId, cId, expectedRevision) => {
        const w = db.prepare('SELECT revision FROM works WHERE id = ?').get(wId);
        if (!w) throw new HttpError(404, 'not_found', '作品不存在');

        const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND work_id = ?').get(cId, wId);
        if (!cue) throw new HttpError(404, 'cue_not_found', '目标字幕段不存在或不属于该作品');

        // 修订号过期：拒绝覆盖，返回最新修订号和目标字幕段
        if (w.revision !== expectedRevision) {
          const latest = db.prepare('SELECT * FROM cues WHERE id = ?').get(cId);
          return { conflict: true, revision: w.revision, cue: latest };
        }

        // 同一作品其他字幕段不得交叠（半开区间，首尾相接允许）
        const overlap = db
          .prepare(
            `SELECT id FROM cues
              WHERE work_id = ? AND id != ? AND start_ms < ? AND end_ms > ?
              LIMIT 1`
          )
          .get(wId, cId, endMs, startMs);
        if (overlap) {
          throw new HttpError(422, 'overlap', '该时间段与同一作品的其他字幕段交叠');
        }

        db.prepare(
          'UPDATE cues SET start_ms = ?, end_ms = ?, text = ? WHERE id = ?'
        ).run(startMs, endMs, text, cId);

        const nextRevision = w.revision + 1;
        db.prepare("UPDATE works SET revision = ?, updated_at = datetime('now') WHERE id = ?")
          .run(nextRevision, wId);

        db.prepare(
          'INSERT INTO revisions_log (work_id, revision, editor, action, cue_id) VALUES (?, ?, ?, ?, ?)'
        ).run(wId, nextRevision, typeof editor === 'string' ? editor.slice(0, 80) : null, 'edit', cId);

        reindexCues(wId);
        const updated = db.prepare('SELECT * FROM cues WHERE id = ?').get(cId);
        return { conflict: false, revision: nextRevision, cue: updated };
      })
      .immediate(workId, cueId, revision);

    if (outcome.conflict) {
      throw new HttpError(409, 'revision_stale', '修订号已过期：该作品已被其他人修改', {
        latest_revision: outcome.revision,
        cue: cueRow(outcome.cue),
      });
    }

    res.json({ revision: outcome.revision, cue: cueRow(outcome.cue) });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 批量平移：预览（不写库）与确认（单事务整批应用）                      */
/* ------------------------------------------------------------------ */

// 预览：返回每段调整前后时间与碰撞对象，以及确认时须携带的当前修订号
app.post('/api/works/:id/shift/preview', (req, res, next) => {
  try {
    const workId = Number(req.params.id);
    const { cueIds, offsetMs } = parseShiftParams(req.body);

    const preview = db.transaction(() => {
      const w = db.prepare('SELECT revision FROM works WHERE id = ?').get(workId);
      if (!w) throw new HttpError(404, 'not_found', '作品不存在');
      const allCues = db
        .prepare('SELECT * FROM cues WHERE work_id = ? ORDER BY idx, id')
        .all(workId);
      assertCuesExist(allCues, cueIds);
      return { revision: w.revision, plan: computeShiftPlan(allCues, cueIds, offsetMs) };
    })();

    res.json({
      revision: preview.revision,
      offset_ms: offsetMs,
      ok: preview.plan.ok,
      items: preview.plan.items,
      problems: shiftProblems(preview.plan),
    });
  } catch (e) {
    next(e);
  }
});

// 确认：携带预览所依据的修订号；同一事务内重算、校验并应用全部时间
app.post('/api/works/:id/shift', (req, res, next) => {
  try {
    const workId = Number(req.params.id);
    const { revision, editor } = req.body || {};

    if (!Number.isInteger(revision) || revision < 1) {
      throw new HttpError(400, 'invalid_revision', '缺少有效的作品修订号');
    }
    const { cueIds, offsetMs } = parseShiftParams(req.body);

    const outcome = db.transaction(() => {
      const w = db.prepare('SELECT revision FROM works WHERE id = ?').get(workId);
      if (!w) throw new HttpError(404, 'not_found', '作品不存在');

      const allCues = db
        .prepare('SELECT * FROM cues WHERE work_id = ? ORDER BY idx, id')
        .all(workId);
      assertCuesExist(allCues, cueIds);

      // 预览所依据的修订号已过期：拒绝按过期预览写入
      if (w.revision !== revision) {
        return { conflict: true, revision: w.revision };
      }

      // 事务内基于最新数据重算全部新时间；任何违例抛错 -> 整批回滚
      const plan = computeShiftPlan(allCues, cueIds, offsetMs);
      if (plan.negative.length > 0) {
        throw new HttpError(
          422,
          'negative_start',
          `平移后 ${plan.negative.length} 个字幕段的开始时间为负，整批未应用`,
          { cues: plan.negative }
        );
      }
      if (plan.pairs.length > 0) {
        throw new HttpError(
          422,
          'overlap',
          `平移后存在 ${plan.pairs.length} 处时间交叠，整批未应用`,
          { pairs: plan.pairs }
        );
      }

      // 只动时间：文字与段标识不变
      const update = db.prepare('UPDATE cues SET start_ms = ?, end_ms = ? WHERE id = ?');
      for (const item of plan.items) {
        update.run(item.after.start_ms, item.after.end_ms, item.cue_id);
      }

      // 整批只推进一次修订号
      const nextRevision = w.revision + 1;
      db.prepare("UPDATE works SET revision = ?, updated_at = datetime('now') WHERE id = ?")
        .run(nextRevision, workId);
      db.prepare(
        'INSERT INTO revisions_log (work_id, revision, editor, action) VALUES (?, ?, ?, ?)'
      ).run(
        workId,
        nextRevision,
        typeof editor === 'string' ? editor.slice(0, 80) : null,
        'shift'
      );

      reindexCues(workId);
      const cues = db
        .prepare('SELECT * FROM cues WHERE work_id = ? ORDER BY idx, id')
        .all(workId);
      return { conflict: false, revision: nextRevision, cues };
    }).immediate();

    if (outcome.conflict) {
      throw new HttpError(
        409,
        'revision_stale',
        '修订号已过期：该作品已被其他人修改，未按过期预览写入',
        { latest_revision: outcome.revision }
      );
    }

    res.json({
      revision: outcome.revision,
      shifted: cueIds.length,
      cues: outcome.cues.map(cueRow),
    });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 导出标准 SRT：按时间重新编号，保留文字换行                          */
/* ------------------------------------------------------------------ */

app.get('/api/works/:id/export', (req, res, next) => {
  try {
    const work = getWorkOr404(req.params.id);
    const cues = db
      .prepare('SELECT start_ms, end_ms, text FROM cues WHERE work_id = ? ORDER BY start_ms, end_ms, id')
      .all(work.id);

    const body = '\uFEFF' + serializeSrt(cues);
    const safeName =
      work.title
        .trim()
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .slice(0, 120) || 'subtitles';

    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.srt`
    );
    res.send(body);
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 错误处理                                                            */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof SrtError) {
    return res.status(422).json({
      error: 'invalid_srt',
      message: err.message,
      line: err.line,
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.code,
      message: err.message,
      ...err.extra,
    });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'too_large', message: '上传文件过大（上限 6MB）' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'bad_json', message: '请求体不是合法 JSON' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal', message: '服务器内部错误' });
});

if (require.main === module) {
  dbReady
    .then(() => {
      app.listen(PORT, () => {
        console.log(`字幕校订服务已启动: http://0.0.0.0:${PORT}`);
        console.log(`数据库: ${DB_PATH}`);
      });
    })
    .catch((err) => {
      console.error('存储初始化失败：', err);
      process.exit(1);
    });
}

module.exports = { app, get db() { return db; }, ready: dbReady };
