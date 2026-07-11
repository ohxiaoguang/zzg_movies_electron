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

- Main：窗口、SQLite 迁移/查询、来源扫描、快速指纹、NFO/资源解析、媒体协议、文件打开、日志和扫描任务。
- Preload：只通过 contextBridge 暴露显式的、带类型的影片库 API。
- Renderer：Vue 页面、筛选分页、卡片/表格、详情编辑、播放器和悬浮预览。

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
~~~

## SQLite

默认数据库位置：

~~~text
app.getPath("userData")/film-library.db
~~~

启动时启用 foreign_keys、WAL 和 5000ms busy timeout，并通过 src/main/database/migrations/001_initial.ts 执行版本化迁移。数据库只在 Main Process 中访问。

主要表：

- media_source：来源 UUID、名称、根路径、启用/递归/归档状态和扫描结果。
- film：文件路径、快速指纹、NFO 元数据、用户状态、评分、收藏、备注和 missing 状态。
- tag / film_tag：影片标签关系。
- genre / film_genre：影片类型关系。
- film_asset：poster、fanart、thumb、extra_fanart、preview、trailer、sample。
- scan_job / scan_error：扫描摘要和单文件错误。
- app_setting：本地设置。

## 添加来源和扫描

在“来源管理”中选择一个外部目录。来源 ID 使用 UUID，修改名称或路径不会改变 ID。来源可以禁用、重新启用或单独扫描。

扫描分为两阶段：

1. 发现和解析：递归遍历来源，过滤忽略目录和 .llc 文件，收集影片候选，匹配 NFO/旁路资源并计算“文件大小 + 开头块哈希 + 结尾块哈希”的快速指纹。
2. 数据库合并：只有来源完整扫描成功后才进入事务，执行 upsert、移动/重命名识别、资源更新和 missing 标记。

来源离线、权限错误、用户取消或扫描异常时，不会对该来源执行 missing 标记，也不会删除数据库影片。

重复扫描按 (source_id, relative_path) 幂等；路径变化时仅在同一来源下存在唯一指纹匹配时识别为移动。指纹冲突不会自动合并。

## NFO 和资源规则

支持常见 NFO 字段：title、originaltitle、sorttitle、year、premiered、releasedate、runtime、plot、outline、tagline、genre、tag、country、studio、director、actor、rating、userrating、mpaa、playcount、watched、fileinfo 和 streamdetails。

解析支持缺失字段、单值/多值、多个 actor/genre/director、不同 ratings 结构和错误 XML。普通重扫不会覆盖用户修改的标题、标签、类型、状态、收藏、评分和备注。详情页提供“从 NFO 补充空字段”和“强制重新导入 NFO”。

默认影片扩展名：mp4、mkv、mov、avi、webm、m4v、ts、flv、wmv。

默认图片扩展名：jpg、jpeg、png、webp。

旁路资源优先匹配同名资源，例如 MovieA-poster.jpg、MovieA-preview.mp4。单影片目录还可匹配 movie.nfo、poster.jpg、folder.jpg、cover.jpg、fanart.jpg、backdrop.jpg、thumb.jpg、preview.mp4、trailer.mp4 和 sample.mp4。同一目录有多部主影片时，不会把通用资源随机分给某一部。

extrafanart/ 中的图片会按自然排序识别。所有资源始终保留在原目录，不复制到应用数据目录。

## 悬浮预览

影片卡片默认显示 poster。鼠标进入后按设置等待，默认 450ms：

- 有明确匹配的视频时按 preview → trailer → sample 播放。
- 视频静音、循环、无控件，移出立即暂停，约 300ms 后释放 src。
- 全局 PreviewManager 保证同一时间最多播放一个卡片视频。
- 视频加载失败回退到图片轮播。
- 没有视频但有 fanart → extrafanart → thumb 时默认每 1200ms 切换一张。
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

ffprobe 是可选的。未配置时仍可扫描、读取 NFO、显示海报并播放已有预览。配置后使用参数数组和 shell: false 读取时长、分辨率、编码器和容器。

日志写入 app.getPath("logs")，记录启动、迁移、扫描摘要、NFO/IPC/媒体协议错误。不会记录视频内容、完整 NFO、用户备注或不必要的完整私人路径。

## 测试

测试使用临时目录和临时 SQLite，不读取用户真实影片目录。当前覆盖：

- 路径安全、中文/空格/括号路径、跨盘和路径穿越。
- Range 起止/后缀/越界处理。
- NFO 多 genre/actor/director、ratings、空字段和错误 XML。
- poster、fanart、thumb、extrafanart 自然排序、preview 优先级、通用资源歧义和 .llc 忽略。
- SQLite 迁移、分页、扫描幂等、用户字段保护、移动识别、离线保护、归档。

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

## 常见问题

- 来源显示离线：确认外部磁盘已连接，再在来源页执行扫描；旧影片不会被批量标记 missing。
- 影片移动后出现两条记录：只有快速指纹唯一匹配时才自动识别；指纹冲突会保守地保留为独立记录。
- 没有海报：确认扩展名在设置中启用，并检查同名/单影片目录资源规则。
- 预览不播放：悬浮预览只接受 preview/trailer/sample，损坏或不兼容的视频会回退到图片。
- 没有 ffprobe：这是可选功能，不会阻止影片导入。

## 已知限制和下一阶段

当前版本不联网刮削，不接入 TMDB/豆瓣/IMDb，不做 AI 分类、自动截图、预览生成、转码、外部文件修改、剧集/季集模型或自动更新。后续可以增加更完善的媒体技术信息、批量编辑、备份/恢复数据库和横向卡片模式。
