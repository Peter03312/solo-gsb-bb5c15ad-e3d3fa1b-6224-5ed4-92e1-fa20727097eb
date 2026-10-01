'use strict';

/* 无第三方依赖的集成测试：内存 SQLite + 真实 HTTP 服务。
   运行：npm test
   退出码非 0 表示有失败用例。 */

process.env.DB_PATH = ':memory:';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { parseSrt, serializeSrt, SrtError, parseTimeToMs, formatMs } = require('../src/srt');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      console.error(`  ✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

function expectSrtError(fn, expectedLine, partOfMessage) {
  try {
    fn();
    assert.fail('应当抛出 SrtError');
  } catch (e) {
    assert.ok(e instanceof SrtError, `应是 SrtError，实际 ${e.constructor.name}`);
    assert.strictEqual(e.line, expectedLine, `行号应为 ${expectedLine}，实际 ${e.line}`);
    if (partOfMessage) {
      assert.ok(
        e.message.includes(partOfMessage),
        `错误信息应包含“${partOfMessage}”，实际：${e.message}`
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* SRT 解析/序列化单元测试                                             */
/* ------------------------------------------------------------------ */

function runUnitTests() {
  test('正常文件：多行文字、CRLF、BOM 都能解析', () => {
    const raw =
      '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\n第一行\r\n第二行\r\n\r\n' +
      '2\r\n00:00:02,500 --> 00:00:03,000\r\n结尾相接可以\r\n';
    const cues = parseSrt(raw);
    assert.strictEqual(cues.length, 2);
    assert.strictEqual(cues[0].start_ms, 1000);
    assert.strictEqual(cues[0].end_ms, 2500);
    assert.strictEqual(cues[0].text, '第一行\n第二行');
    assert.strictEqual(cues[1].text, '结尾相接可以');
  });

  test('序号行格式错误，报出行号', () => {
    const raw = '1\n00:00:01,000 --> 00:00:02,000\n甲\n\n??\n00:00:03,000 --> 00:00:04,000\n乙\n';
    expectSrtError(() => parseSrt(raw), 5, '序号');
  });

  test('时间轴格式错误，报出时间轴所在行号', () => {
    const raw = '1\n00:00:01,000 -> 00:00:02,000\n甲\n';
    expectSrtError(() => parseSrt(raw), 2, '时间轴');
  });

  test('结束不晚于开始，报出行号', () => {
    const raw = '1\n00:00:05,000 --> 00:00:05,000\n甲\n';
    expectSrtError(() => parseSrt(raw), 2, '结束时间');
  });

  test('缺少字幕文字，报出行号', () => {
    const raw = '1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:03,000 --> 00:00:04,000\n乙\n';
    expectSrtError(() => parseSrt(raw), 2, '文字');
  });

  test('整份文件内时间交叠，报出后一段序号所在行', () => {
    const raw =
      '1\n00:00:01,000 --> 00:00:03,000\n甲\n\n' +
      '2\n00:00:02,000 --> 00:00:04,000\n乙\n';
    expectSrtError(() => parseSrt(raw), 5, '交叠');
  });

  test('空文件报错', () => {
    expectSrtError(() => parseSrt('   \n\n'), 1, '没有任何字幕');
  });

  test('时间码换算与格式化', () => {
    assert.strictEqual(parseTimeToMs('01:02:03,456'), 3723456);
    assert.strictEqual(formatMs(3723456), '01:02:03,456');
    // 点号也接受
    assert.strictEqual(parseTimeToMs('00:00:00.500'), 500);
  });

  test('序列化按时间重新编号并保留多行换行', () => {
    const out = serializeSrt([
      { start_ms: 2000, end_ms: 3000, text: 'b 行1\nb 行2' },
      { start_ms: 1000, end_ms: 2000, text: 'a' },
    ]);
    const expected =
      '1\n00:00:01,000 --> 00:00:02,000\na\n\n' +
      '2\n00:00:02,000 --> 00:00:03,000\nb 行1\nb 行2\n';
    assert.strictEqual(out, expected);
  });
}

/* ------------------------------------------------------------------ */
/* HTTP 集成测试                                                       */
/* ------------------------------------------------------------------ */

const VALID_SRT =
  '1\r\n00:00:01,000 --> 00:00:02,000\r\n你好世界\r\n第二行\r\n\r\n' +
  '2\r\n00:00:02,000 --> 00:00:03,500\r\n第二段\r\n';

async function main() {
  console.log('SRT 解析单元测试：');
  runUnitTests();

  // 集成测试使用临时文件库（而非 :memory:），以覆盖快照落盘、
  // export() 后预编译语句失效重建、重启持久化等路径。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-collab-test-'));
  process.env.DB_PATH = path.join(tmpDir, 'test.db');

  const { app, ready } = require('../src/server');
  await ready;
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };

  console.log('\nHTTP 接口测试：');

  await test('非法 SRT 上传返回 422 与行号，且整份不入库', async () => {
    const bad = '1\n00:00:01,000 --> 00:00:02,000\n甲\n\n2\n00:00:02,000 --> 00:00:01,000\n乙\n';
    const r = await call('POST', '/api/works', { title: '坏文件', filename: 'bad.srt', content: bad });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error, 'invalid_srt');
    assert.strictEqual(r.json.line, 6);

    const list = await call('GET', '/api/works');
    assert.strictEqual(list.json.works.length, 0, '坏文件不应产生任何作品');
  });

  await test('合法 SRT 上传成功，修订号为 1', async () => {
    const r = await call('POST', '/api/works', { title: '测试片', filename: 'sample.srt', content: VALID_SRT });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 1);
    assert.strictEqual(r.json.cue_count, 2);
  });

  let cueId;
  let cue2Id;
  await test('作品详情按时间顺序返回字幕段', async () => {
    const r = await call('GET', '/api/works/1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.cues.length, 2);
    assert.strictEqual(r.json.cues[0].text, '你好世界\n第二行');
    assert.strictEqual(r.json.cues[0].idx, 1);
    cueId = r.json.cues[0].id;
    cue2Id = r.json.cues[1].id;
  });

  await test('携带正确修订号编辑：多行文字与时间可改，修订号变 2', async () => {
    // cue2 为 02.000–03.500，这里与它首尾相接，不构成交叠
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 1,
      start: '00:00:01,200',
      end: '00:00:02,000',
      text: '改后第一行\n改后第二行\n第三行',
      editor: '阿校对',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 2);
    assert.strictEqual(r.json.cue.start_ms, 1200);
    assert.strictEqual(r.json.cue.end_ms, 2000);
    assert.strictEqual(r.json.cue.text, '改后第一行\n改后第二行\n第三行');
  });

  await test('用过期修订号 1 再次编辑：409，返回最新修订号与目标字幕段', async () => {
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 1,
      start: '00:00:01,300',
      end: '00:00:02,000',
      text: '过期修改',
    });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error, 'revision_stale');
    assert.strictEqual(r.json.latest_revision, 2);
    assert.strictEqual(r.json.cue.id, cueId);
    // 目标字幕段是服务器上的最新版本
    assert.strictEqual(r.json.cue.text, '改后第一行\n改后第二行\n第三行');
    assert.strictEqual(r.json.cue.start, '00:00:01,200');
  });

  await test('时间结束早于开始：422 拒绝，修订号与内容不变', async () => {
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 2,
      start: '00:00:05,000',
      end: '00:00:01,000',
      text: '改后第一行\n改后第二行\n第三行',
    });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error, 'invalid_range');

    const detail = await call('GET', '/api/works/1');
    assert.strictEqual(detail.json.work.revision, 2, '失败的编辑不应推进修订号');
    assert.strictEqual(detail.json.cues[0].start, '00:00:01,200');
  });

  await test('非法时间格式：400 拒绝', async () => {
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 2,
      start: '1秒',
      end: '00:00:02,000',
      text: 'x',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'invalid_time');
  });

  await test('与其他字幕段交叠：422 拒绝', async () => {
    // cue2 当前 02.000–03.500；把 cue1 改成 01.500–02.200 会与之交叠
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 2,
      start: '00:00:01,500',
      end: '00:00:02,200',
      text: '改后第一行\n改后第二行\n第三行',
    });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error, 'overlap');

    const detail = await call('GET', '/api/works/1');
    assert.strictEqual(detail.json.work.revision, 2);
    assert.strictEqual(detail.json.cues[0].start, '00:00:01,200');
  });

  await test('首尾相接（前一段结束==后一段开始）不算交叠，允许保存', async () => {
    // cue1 改为 00:00:01,200 -> 00:00:02,000，正好接上 cue2 的开始
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 2,
      start: '00:00:01,200',
      end: '00:00:02,000',
      text: '改后第一行\n改后第二行\n第三行',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 3);
  });

  await test('空文字被拒绝', async () => {
    const r = await call('PUT', `/api/works/1/cues/${cue2Id}`, {
      revision: 3,
      start: '00:00:02,000',
      end: '00:00:03,500',
      text: '   \n  ',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'invalid_text');
  });

  await test('并发两处相同修订号提交：恰好一个成功、另一个 409', async () => {
    const [a, b] = await Promise.all([
      call('PUT', `/api/works/1/cues/${cueId}`, {
        revision: 3,
        start: '00:00:01,200',
        end: '00:00:02,000',
        text: '并发编辑',
      }),
      call('PUT', `/api/works/1/cues/${cue2Id}`, {
        revision: 3,
        start: '00:00:02,000',
        end: '00:00:03,500',
        text: '第二处并发',
      }),
    ]);
    const ok = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 409);
    assert.strictEqual(ok.length, 1, `应有一个成功，实际 ${ok.length}：${JSON.stringify([a.json, b.json])}`);
    assert.strictEqual(conflicts.length, 1, '应有一个 409 冲突');
    assert.strictEqual(conflicts[0].json.latest_revision, 4);
  });

  await test('导出标准 SRT：按时间重新编号，换行保留，带 UTF-8 BOM', async () => {
    const res = await fetch(base + '/api/works/1/export');
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('x-subrip'));
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, '应以 BOM 开头');
    const body = buf.toString('utf8').replace(/^\uFEFF/, '');
    const lines = body.replace(/\r\n?/g, '\n').split('\n');
    // 编号从 1 连续递增
    assert.strictEqual(lines[0], '1');
    assert.ok(lines.some((l) => l === '2'));
    // 多行文字换行仍在（并发测试中恰好一处保存成功）
    assert.ok(
      body.includes('改后第一行\n改后第二行\n第三行') ||
        body.includes('并发编辑') ||
        body.includes('第二处并发'),
      '导出内容应包含多行文字换行'
    );
  });

  await test('持久化：用 openDb 重新打开文件，数据与修订号都在', async () => {
    const { openDb } = require('../src/db');
    const db2 = await openDb(process.env.DB_PATH);
    const w = db2.prepare('SELECT title, revision FROM works WHERE id = ?').get(1);
    assert.ok(w, '重开后应能读到作品');
    assert.ok(w.revision >= 4, `修订号应为并发后的 >=4，实际 ${w.revision}`);
    const n = db2.prepare('SELECT COUNT(*) AS n FROM cues WHERE work_id = ?').get(1);
    assert.strictEqual(n.n, 2);
  });

  await test('删除作品后列表与详情都消失', async () => {
    const r = await call('DELETE', '/api/works/1');
    assert.strictEqual(r.status, 200);
    const detail = await call('GET', '/api/works/1');
    assert.strictEqual(detail.status, 404);
  });

  await new Promise((resolve) => server.close(resolve));

  if (process.exitCode) {
    console.log(`\n有失败用例；通过 ${passed} 个。`);
  } else {
    console.log(`\n全部 ${passed} 个用例通过。`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
