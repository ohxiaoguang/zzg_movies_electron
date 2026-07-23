# Local Film Library

一个完全本地运行的 Windows 影片资料管理桌面程序。它只读取外部影片目录中的影片、NFO、海报、背景图和预览视频，并把索引与用户编辑内容保存到 SQLite；不会复制、修改、移动、重命名或删除外部媒体文件。

## 技术架构

- Electron Forge 7.11 + Vite 8
- Electron 42.6.1（与 better-sqlite3 12.11.1 的 Electron ABI 146 预编译包匹配）
- Vue 3 + TypeScript 6 + Vue Router 5 + Pinia 3
- Element Plus
- SQLite + better-sqlite3
- fast-xml-parser、Vitest、ESLint、Prettier

职责边界：

- Main：窗口、SQLite 迁移/查询、来源扫描、NFO/资源解析、媒体协议、文件打开、日志和扫描任务。
- Preload：只通过 contextBridge 暴露显式的、带类型的影片库 API。
- Renderer：Vue 页面、筛选分页、卡片/表格、详情自动保存、播放器和独立悬浮预览。

Renderer 不导入 fs、path、better-sqlite3 或 shell，也不能直接调用任意 IPC channel。

## 安装和运行

要求 Node.js 20+，推荐 Node.js 24 与 npm 11。

~~~powershell
npm install
npm start
~~~

如果 npm 11 提示依赖安装脚本需要审批，请确认 better-sqlite3 和 electron-winstaller 的官方安装脚本后再执行：

~~~powershell
npm approve-scripts better-sqlite3 electron-winstaller
~~~

常用工程脚本：

~~~powershell
npm run lint
npm run typecheck
npm test
npm run test:watch
npm run package
npm run make
npm run smoke:package
# 在已启动的 npm start DevTools 会话中：
node scripts/smoke-dev-save.mjs <remote-debugging-port> <temporary-root>
~~~

## GitHub 自动发布

向 GitHub 推送语义化版本 Tag（例如 `v1.2.3` 或 `1.2.3`）会触发 `.github/workflows/release.yml`。工作流在 Windows Runner 中执行类型检查、Lint、Forge 打包和生产包启动验证，然后创建同名 GitHub Release，上传安装程序、ZIP、Squirrel `RELEASES` 和增量包。Tag 发布流程不运行 Vitest 测试套件。

Release 固定使用 `windows-2022` Runner。当前 Forge 间接依赖的 `@electron/rebuild 3.x / node-gyp` 尚不能识别 `windows-latest` 中的 Visual Studio 2026，而 Windows Server 2022 提供兼容的 Visual Studio 2022 C++ 工具链。

打包前会去掉可选的 `v` 前缀，并把该版本写入临时的 `package.json` / `package-lock.json`；因此 `v1.2.3` 对应程序内部版本 `1.2.3`，设置页和 `app.getVersion()`、安装包及 ZIP 版本保持一致。CI 中的临时版本修改不会提交回仓库。

~~~powershell
git tag v1.2.3
git push origin v1.2.3
~~~

## SQLite

默认数据库位置：

~~~text
app.getPath("userData")/film-library.db
~~~

启动时启用 foreign_keys、WAL 和 5000ms busy timeout，并执行版本化事务迁移。当前 schema 版本为 v6；数据库只在 Main Process 中访问。

主要表：

- media_source：来源 UUID、名称、根路径、启用/递归/归档状态和扫描结果。
- film_file：逻辑影片下的单文件或严格按 `名称-cd1`、`名称-cd2` 命名的分段文件及缺失状态。
- film：文件路径、NFO 元数据、评分、收藏、备注和 missing 状态。
- tag / film_tag：从 NFO `<tag>` 读取的只读标签关系。
- custom_category / film_custom_category：用户创建的“我的分类”及多对多影片关系。
- genre / film_genre：旧类型兼容表，暂时保留但正式业务不再读取或写入。
- film_asset：poster、fanart、thumb、extra_fanart、preview、trailer、sample。
- scan_job / scan_error：扫描摘要和单文件错误。
- app_setting：本地设置。

## 添加来源和扫描

在“来源管理”中选择一个外部目录。来源 ID 使用 UUID，修改名称或路径不会改变 ID。来源可以禁用、重新启用或单独扫描。

- 来源管理中每个来源都有“重新扫描”按钮，只扫描该来源。
- 影片详情页有“重新扫描目录”按钮，只遍历当前影片所在目录；扫描成功后的 missing 标记也严格限制在该目录，不影响同一来源中的其他目录。
- 来源管理中每个来源都有“原片预览”复选框，默认关闭。勾选后，该来源影片在没有 preview、trailer 或 sample 时可直接使用主视频完整预览；已有专用预览资源时仍优先使用专用资源。

扫描分为两阶段：

1. 发现和解析：递归遍历来源，过滤忽略目录和 .llc 文件，按来源内的相对目录与完整文件名收集影片候选，并匹配 NFO/旁路资源。
2. 数据库合并：只有来源完整扫描成功后才进入事务，按精确相对路径执行 upsert、资源更新和 missing 标记。

来源离线、权限错误、用户取消或扫描异常时，不会对该来源执行 missing 标记，也不会删除数据库影片。

重复扫描按 (source_id, relative_path) 幂等。扫描器不读取或比较视频内容指纹；即使两个视频内容完全相同，只要文件名不同就会保留为两部影片。文件改名或移动后，旧路径标记为缺失，新路径作为新影片导入。

只有同目录下严格匹配 `名称-cd1.扩展名`、`名称-cd2.扩展名`、`名称-cd3.扩展名` 的文件才组成一部影片。相同主文件名但扩展名不同（例如 `1 (3).ts` 与 `1 (3).mp4`）仍是两部独立影片；`disc`、下划线或空格形式不再自动分组。

## NFO 和资源规则

支持常见 NFO 字段：title、originaltitle、sorttitle、year、premiered、releasedate、runtime、plot、outline、tagline、tag、country、studio、director、actor、rating、userrating、mpaa、fileinfo 和 streamdetails。底层解析器仍能识别 genre/watched 以兼容 NFO 格式和解析测试，但应用业务不再展示、筛选或保存“类型”和手工观看状态。

NFO `<tag>` 只作为只读元数据展示和筛选，Renderer 不提供新增、删除或修改标签的入口。详情页提供“从 NFO 补充空字段”和明确选择“合并/替换”的强制重新导入。程序没有写回 NFO 的 API，所有扫描和详情操作都不会修改外部 NFO。

## 标签、我的分类与整理状态

- NFO 标签来自 `<tag>`，只读；它与“我的分类”使用完全不同的表和 API。
- “我的分类”由用户创建、重命名、排序和删除，一部影片可关联多个分类。不会从 NFO 标签或旧类型自动迁移分类。
- 删除分类只删除分类及影片关系，不删除影片记录，不影响收藏或 NFO 标签，也不触碰外部文件。
- “未整理”是动态查询结果：影片不存在 `film_custom_category` 关系。
- “已整理”是动态查询结果：影片至少存在一条 `film_custom_category` 关系。
- “演员”菜单汇总 SQLite 中由 NFO `<actor>` 建立的演员索引和影片数量；点击演员会返回“全部影片”并应用该演员筛选。影片页也可以直接使用“NFO 演员”下拉筛选。
- “已整理”页面可把当前筛选结果导出为 UTF-8 CSV，固定字段为文件名、NFO 标题、我的分类、演员和 NFO 摘要。导出会再次强制限定为已整理影片，不受当前分页大小限制。
- “所有数据”可筛选“自动标题与单文件名不一致”和“非 CD 多文件错误合并”记录，支持多选后只删除 SQLite 索引，再通过重新扫描按当前文件名生成记录；不会删除外部视频。
- 收藏立即自动保存；分类变化约 200ms 后自动保存。详情关闭前会刷新待发送修改，失败时保留当前选择并提供重试。
- 旧 `film.status`、`genre`、`film_genre` 和 `genres_user_edited` 结构为数据库升级兼容暂时保留，业务 DTO、IPC、筛选、菜单和界面均不再依赖它们。

默认影片扩展名：mp4、mkv、mov、avi、webm、m4v、mpg、mpeg、ts、flv、wmv。

默认图片扩展名：jpg、jpeg、png、webp。

旁路资源优先匹配同名资源，例如 MovieA-poster.jpg、MovieA-preview.mp4。单影片目录还可匹配 movie.nfo、poster.jpg、folder.jpg、cover.jpg、fanart.jpg、backdrop.jpg、thumb.jpg、preview.mp4、trailer.mp4 和 sample.mp4。同一目录有多部主影片时，MovieA.jpg 或 MovieA.jpeg 会作为 MovieA 视频的海报；MovieA-poster.jpg 仍具有更高优先级，并且不会把 poster.jpg 等通用资源随机分给某一部。

extrafanart/ 中的图片会按自然排序识别。所有资源始终保留在原目录，不复制到应用数据目录。

## 悬浮预览

影片卡片始终保持 2:3 poster。鼠标进入后按设置等待，默认 450ms，在 body 上显示不参与网格布局的 16:9 横向悬浮窗：

- 有明确匹配的视频时按 preview → trailer → sample 播放；来源允许“原片预览”时，三者均不存在才回退到主视频。
- MKV 预览会优先使用 ffprobe 判断编码：H.264/AAC 只重封装，HEVC 或其他不兼容编码转为 H.264/AAC；即使文件扩展名是 MKV、内部实际为 MPEG-TS 也可处理。首次播放会显示准备提示并生成应用内部 MP4 缓存，之后通过标准 Content-Length 和 Range 连续播放，不会修改来源目录。缓存会按源文件路径、大小和修改时间自动失效，并清理 14 天未使用或总量超过 2GB 的旧文件。
- 视频静音、循环、无控件；离开卡片和悬浮窗 180ms 后关闭并释放 src。
- 全局管理器保证同一时间最多一个悬浮窗和一个视频播放器。
- 视频加载失败回退到图片轮播。
- 没有视频时在 fanart 和 extrafanart 中默认每 1200ms 切换一张。
- 卡片销毁、离开可视区域或鼠标移出时清理定时器和媒体资源。
- 不会把原始完整影片作为悬浮预览。

## 自定义媒体协议和安全设计

主进程在 app.ready 前注册特权协议 film-media://，通过 protocol.handle() 提供：

~~~text
film-media://asset/<asset-uuid>
film-media://preview/<film-uuid>
film-media://poster/<film-uuid>
~~~

URL 只接受合法 UUID。Main 根据 UUID 查 SQLite，再拼接并校验来源根路径；拒绝绝对路径、路径穿越、跨盘路径、离线来源和不存在文件。视频使用流式 fs.createReadStream，支持 Range、206、Accept-Ranges、Content-Range 和拖动进度，不启动本地 HTTP 服务。

BrowserWindow 使用 nodeIntegration: false、contextIsolation: true、sandbox: true 和显式 preload。导航仅允许应用本地页面，未知新窗口全部拒绝，并启用严格 CSP。

原片和目录操作只接受影片 UUID，分别调用 shell.openPath() 和 shell.showItemInFolder()；不会拼接或执行 cmd、PowerShell、start 或 explorer.exe 命令。

## 删除来源

- 禁用：停止扫描，影片记录保留。
- 归档：删除来源配置的可用状态，保留并归档影片记录。
- 删除记录：删除来源和数据库影片关系。

两种删除都不会触碰外部影片、图片、NFO 或预览视频。

## ffprobe 和日志

ffprobe 是可选的。未配置时仍可扫描、读取 NFO、显示海报并播放已有预览。配置后使用参数数组和 shell: false 读取时长、分辨率、编码器和容器。MKV、MPG/MPEG、AVI、TS、FLV、WMV 兼容预览会查找 ffprobe 同目录下的 ffmpeg，也会从系统 PATH 查找 ffmpeg/ffprobe；找不到 ffmpeg 时保留 Chromium 原生播放作为回退，并在日志中记录明确原因。

日志写入 app.getPath("logs")，记录启动、迁移、扫描摘要、NFO/IPC/媒体协议错误。不会记录视频内容、完整 NFO、用户备注或不必要的完整私人路径。

## 测试

测试使用临时目录和临时 SQLite，不读取用户真实影片目录。当前覆盖：

- 路径安全、中文/空格/括号路径、跨盘和路径穿越。
- Range 起止/后缀/越界处理。
- NFO 多 genre/actor/director、ratings、空字段和错误 XML。
- NFO 标签只读、类型不进入正式业务存储、分类与 NFO 标签完全隔离。
- 分类名称规范化、重复拒绝、事务回滚、排序、计数、多分类关系和删除安全。
- 未整理/已整理、收藏、分类 any/all、普通影片可用性和所有数据查询。
- NFO 演员统计、演员筛选、已整理 CSV 数据范围和 CSV 特殊字符转义。
- poster、fanart、thumb、extrafanart 自然排序、preview 优先级、通用资源歧义和 .llc 忽略。
- SQLite 迁移、分页、扫描幂等、用户字段保护、同内容不同文件名隔离、离线保护、归档。
- 单影片目录重扫、目录范围 missing 隔离和来源定向扫描。

## better-sqlite3 和打包

Forge 配置启用了 @electron-forge/plugin-auto-unpack-natives，并显式保留 better-sqlite3、bindings 和 file-uri-to-path 生产依赖，使 native .node 文件进入 app.asar.unpacked。当前锁定 Electron 42.6.1，是因为 better-sqlite3 12.11.1 的稳定预编译包提供 Electron ABI 146。

npm run package 生成目录：

~~~text
out/local-film-library-win32-x64/
~~~

npm run make 生成：

~~~text
out/make/squirrel.windows/x64/LocalFilmLibrarySetup.exe
out/make/zip/win32/x64/local-film-library-win32-x64-0.1.0.zip
~~~

`npm run smoke:package` 使用临时用户数据和临时媒体目录验证数据库迁移、三段影片合并、详情图片、设置保存、来源删除/恢复和 IPC。测试结束会清理临时目录。

## 常见问题

- 来源显示离线：确认外部磁盘已连接，再在来源页执行扫描；旧影片不会被批量标记 missing。
- 影片改名或移动后出现两条记录：这是按文件名识别的预期行为；旧路径保留为缺失记录，新路径作为新影片导入，可在“全部数据”中删除不再需要的旧记录。
- 没有海报：确认扩展名在设置中启用，并检查同名/单影片目录资源规则。
- 预览不播放：悬浮预览只接受 preview/trailer/sample，损坏或不兼容的视频会回退到图片。
- 没有 ffprobe：这是可选功能，不会阻止影片导入。

## 已知限制和下一阶段

当前版本不联网刮削，不接入 TMDB/豆瓣/IMDb，不做分类层级、AI 分类、自动截图、预览生成、转码、外部文件修改、NFO 导出、剧集/季集模型或自动更新。后续可以增加更完善的媒体技术信息、批量编辑、备份/恢复数据库和横向卡片模式。
