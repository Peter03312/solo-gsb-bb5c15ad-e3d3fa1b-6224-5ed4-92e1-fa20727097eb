# 字幕校订台 · 多人协作 SRT 校订 Web 应用

面向小型放映团队的浏览器字幕校订工具：上传 **UTF-8 编码的 SRT**，按时间轴逐段
校订起止时间与多行文字，多人同时修改时用**作品修订号（乐观锁）**防止互相覆盖，
随时导出重新编号的标准 SRT。

技术栈：Node.js（Express）+ SQLite（sql.js / WebAssembly）+ 原生浏览器界面，
无前端构建步骤。

---

## 功能一览

- **上传校验**：严格按行解析 UTF-8 SRT（支持 CRLF、BOM、逗号或点号毫秒分隔）。
  序号、时间轴格式、时间合法性（非负、结束晚于开始）、**同作品字幕段不得交叠**
  全部通过后才入库；任何一项失败都会返回**出错行号**，且**整份文件不入库**。
- **逐段校订**：按时间顺序展示全部字幕段，可修改开始/结束时间与多行文字，
  行内换行完整保留。
- **多人并发保护**：每次保存携带作品修订号。修订号过期时服务器**拒绝覆盖**，
  返回 `409`、最新修订号以及目标字幕段的最新内容；界面就地展示服务器版本，
  校订人人工对照合并后再保存。
- **时间约束**：结束必须晚于开始（时间不可为负），新时间段与同作品其他字幕段
  不得交叠（相邻段首尾相接允许）。违例保存被拒绝且不推进修订号。
- **导出标准 SRT**：按开始时间重新从 1 连续编号，文字多行换行原样保留，
  输出带 UTF-8 BOM 的标准 SRT 文件。

## 一键启动（Docker Compose）

需要 Docker 20.10+ 与 Docker Compose v2。

```bash
docker compose up -d --build
```

该命令会：

1. 构建镜像并在镜像内 `npm install`（安装依赖）；
2. 首次启动时应用自动创建 SQLite 数据库与全部表（初始化存储）；
3. 以后台方式启动服务，并随 Docker 自动重启。

访问地址：

- 本机：<http://localhost:3000>
- 局域网：`http://<本机 IP>:3000`

停止 / 查看日志：

```bash
docker compose down        # 停止（数据保留在命名卷 srt-data 中）
docker compose logs -f     # 跟踪日志
```

## 配置

所有配置通过环境变量传入，修改后执行 `docker compose up -d` 生效。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST_PORT` | `3000` | 宿主机映射端口。例如 `HOST_PORT=8080 docker compose up -d --build` 后访问 <http://localhost:8080> |
| `PORT` | `3000` | 容器内监听端口，一般无需修改（改动需同步调整 compose 端口映射右侧） |
| `DB_PATH` | `/data/subtitles.db` | 容器内数据库文件路径，位于持久化卷中 |

数据保存在 Docker 命名卷 `srt-data`（挂载于容器 `/data`）。
如希望直接映射到宿主机目录，可把 `docker-compose.yml` 中的

```yaml
volumes:
  - srt-data:/data
```

改为

```yaml
volumes:
  - ./data:/data
```

> 存储说明：SQLite 通过 sql.js（WebAssembly）运行，每次写事务提交后把数据库
> 原子快照写回磁盘（先写临时文件再 rename）。对放映团队这种几十至几千段字幕、
> 少量并发校订的场景完全够用；读取始终在内存中完成，速度很快。

## 不用 Docker 的本地运行

需要 Node.js 18+。

```bash
npm install
npm start
```

默认数据库写到项目下 `data/subtitles.db`，访问 <http://localhost:3000>。
可用环境变量覆盖：

```bash
PORT=8080 DB_PATH=/var/lib/srt/sub.db npm start
```

## 运行测试

测试使用内存数据库，不产生任何文件：

```bash
npm test
```

覆盖：SRT 解析各类非法输入与行号定位、多行文字、交叠检测、整份不入库、
乐观锁 409 冲突（含并发双写）、时间/交叠拒绝不推进修订号、导出重新编号
与换行保留、重启持久化等 22 个用例。

## HTTP 接口摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/works` | 作品列表（含段数、修订号） |
| `POST` | `/api/works` | 上传 SRT：`{title, filename, content}`；失败返回 `422 {error:"invalid_srt", line, message}`，不入库 |
| `GET` | `/api/works/:id` | 作品详情与按时间排序的字幕段 |
| `PUT` | `/api/works/:id/cues/:cueId` | 保存单段：`{revision, start, end, text, editor?}`；修订号过期返回 `409 {latest_revision, cue}`，时间/交叠非法返回 `422` |
| `GET` | `/api/works/:id/export` | 下载按时间重新编号的标准 SRT |
| `DELETE` | `/api/works/:id` | 删除作品及其全部字幕段 |

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── README.md
├── src/
│   ├── server.js      # Express 路由：上传/编辑/导出、乐观锁与交叠校验
│   ├── db.js          # SQLite 存储（sql.js wasm，快照持久化，建表初始化）
│   └── srt.js         # SRT 严格解析（带行号报错）与标准序列化
├── public/            # 浏览器界面（原生 HTML/CSS/JS）
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── test/test.js       # 单元 + HTTP 集成测试
```

## 使用流程建议

1. 一位同学上传片方字幕，其他人在作品列表中打开同一作品；
2. 各人在「校订人署名」填自己的名字（随修改记录保存）；
3. 改一段点一段的「保存」。若期间别人先保存过，该段会出现黄色冲突提示，
   其中附有服务器最新内容；对照合并后再次保存即可；
4. 校订完成后点右上角「导出标准 SRT」，文件可直接用于放映软件。
