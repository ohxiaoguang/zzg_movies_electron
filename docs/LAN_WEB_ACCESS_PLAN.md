# 局域网网页访问与播放改造计划

## 1. 文档目的

本文档用于指导当前 Local Film Library Electron 项目增加可选的局域网服务和移动网页端。

目标不是创建第二套独立产品，也不是立即实现完整的 Jellyfin 兼容服务器，而是在保留现有 Electron 桌面管理端的基础上，让同一台电脑可以：

- 继续通过 Electron 桌面端进行完整管理；
- 在本机浏览器通过 `http://localhost:<port>` 访问；
- 在同一局域网的电脑或手机通过 `http://<host-ip>:<port>` 访问；
- 在网页端使用本项目特有的标签、类型、分类、演员、筛选、收藏、扫描和播放能力；
- 将 Infuse 保留为复杂格式或高规格影片的可选播放器，而不是网页端的必需依赖。

## 2. 当前项目真实状态

### 2.1 页面加载方式

- 开发环境中，Electron `BrowserWindow` 加载 Electron Forge/Vite 提供的临时开发服务器。
- 打包后的正式版本通过 `loadFile()` 加载安装包中的本地 HTML。
- 当前正式版没有 HTTP 服务，不监听局域网端口，也不是通过 `localhost` 运行。

### 2.2 数据与业务调用

- Vue 渲染端主要通过 preload 暴露的 `window.filmLibrary` 调用 Electron IPC。
- SQLite 由 Electron 主进程中的 `better-sqlite3` 管理。
- 扫描、来源、影片、标签、类型、分类和设置等能力目前通过 IPC handler 访问 repository/service。
- 浏览器不能使用 Electron preload 或 IPC，因此当前 Vue 页面不能直接作为普通网页发布。

### 2.3 媒体访问

- 当前海报、预览图和视频主要通过自定义 `film-media://` 协议访问。
- `MediaProtocol` 已经具备 `GET`、`HEAD`、字节范围请求和流式读取基础。
- 普通浏览器不认识 `film-media://`，局域网页面需要标准 HTTP 媒体接口。
- 当前预览转码缓存可以复用部分思路，但尚不是支持多个局域网客户端的完整流媒体服务。

## 3. 已确定的产品决策

1. 保持一个代码库、一个数据库、一个安装包。
2. 增加“启用局域网访问”设置，默认关闭。
3. Electron 桌面界面继续使用本地打包页面和受控 preload，不改为依赖 HTTP 服务启动。
4. Electron IPC 与 HTTP API 必须调用同一套业务服务，不能复制两套扫描和数据规则。
5. 局域网页面是主要的远程浏览、管理和播放入口。
6. 手机端优先使用响应式网页，后续可增加 PWA。
7. Infuse 暂时通过 Windows SMB 或现有 Jellyfin 使用，作为复杂格式播放的可选方案。
8. 第一阶段不实现 Jellyfin API 兼容。
9. 第一阶段不开放互联网访问、端口映射或公网部署。
10. 禁止因为网页功能写回或修改外部 NFO；延续当前“人工修改只写 SQLite”的规则。
11. 不建立长期独立的“局域网版”分支。功能稳定后应合并回主线，并由设置控制是否启用。

## 4. 推荐分支策略

开始编码前：

1. 确认当前工作区状态。
2. 确认当前桌面功能可以正常通过类型检查、Lint 和测试。
3. 从当前稳定提交创建功能分支：

```text
codex/lan-access
```

如果改造时间较长，可以在该分支内按里程碑提交，但不建议长期维护另一套产品分支。

推荐提交拆分：

1. `refactor: extract shared application services`
2. `feat: add localhost web api foundation`
3. `feat: add authenticated lan web access`
4. `feat: add responsive web library`
5. `feat: add http media range streaming`
6. `feat: add web management permissions`
7. `feat: add hls remux and transcode sessions`

## 5. 目标架构

```text
影片目录 / NFO / 图片
          │
          ▼
  Scanner + Repositories
          │
          ▼
  Shared Application Services
      │              │
      │              ├── HTTP API + Media Server
      │              │         │
      ▼              │         ├── 本机浏览器
 Electron IPC        │         └── 局域网电脑/手机
      │              │
      ▼              ▼
 Electron 桌面端   响应式 Web 客户端
```

### 5.1 共享业务服务层

逐步从现有 IPC handler 中抽取可复用的应用服务。IPC 和 HTTP 只负责：

- 参数解析；
- 身份与权限检查；
- 调用应用服务；
- 将结果转换为统一 DTO；
- 记录诊断日志。

扫描规则、文件匹配、NFO 导入覆盖规则、用户编辑保护、标签和类型更新规则只能存在一份。

### 5.2 客户端传输抽象

渲染端建立统一接口，例如 `FilmLibraryClient`：

- `ElectronFilmLibraryClient`：调用现有 `window.filmLibrary`；
- `HttpFilmLibraryClient`：调用 `/api/v1/...`；
- 页面组件和 Pinia store 尽量依赖统一接口，不直接散落调用 IPC 或 `fetch`。

不要一次性重写全部页面。应从影片列表、详情和媒体 URL 开始逐步迁移。

### 5.3 HTTP 服务

HTTP 服务运行在 Electron 主进程中，并与 IPC 共用同一个数据库连接和业务服务实例。

建议目录职责：

```text
src/main/server/
  LanServer.ts
  routes/
  auth/
  middleware/
  media/

src/main/services/
  FilmService.ts
  SourceService.ts
  ScanService.ts
  TaxonomyService.ts

src/shared/
  api-contracts/
```

具体目录应结合现有代码调整，不要求机械照搬。

## 6. 服务启停与设置

建议增加以下设置：

- `lanServerEnabled`：是否启用；
- `lanServerPort`：端口，提供合理默认值；
- `lanServerBindMode`：`localhost` 或 `lan`；
- `lanServerHost`：可选的指定网卡地址；
- `lanKeepRunningInTray`：关闭窗口后是否继续服务；
- `lanRequireAuthentication`：局域网模式必须为 `true`；
- 已配对设备列表及撤销入口。

行为要求：

- 默认仅监听 `127.0.0.1`。
- 用户明确启用局域网模式后，才监听选定的私有网卡地址或 `0.0.0.0`。
- 启动失败、端口占用、地址无效时不能导致 Electron 桌面端退出。
- 设置页显示服务状态、本机地址、局域网地址和二维码。
- Windows 关闭窗口后的默认行为需要明确；如果启用托盘服务，托盘中必须提供停止服务和退出程序。
- 电脑关机、休眠或程序退出后，局域网服务不可用。

## 7. API 初步范围

所有路由使用版本前缀：

```text
/api/v1
```

首轮只读 API 建议包括：

```text
GET  /api/v1/health
GET  /api/v1/server-info
POST /api/v1/auth/pair
POST /api/v1/auth/refresh
POST /api/v1/auth/revoke

GET  /api/v1/films
GET  /api/v1/films/:id
GET  /api/v1/filters/counts
GET  /api/v1/categories
GET  /api/v1/tags
GET  /api/v1/genres
GET  /api/v1/actors
GET  /api/v1/sources
```

媒体接口建议按数据库 ID 解析，不允许客户端提交任意磁盘路径：

```text
GET/HEAD /media/v1/assets/:assetId
GET/HEAD /media/v1/previews/:filmId
GET/HEAD /media/v1/originals/:filmId
GET/HEAD /media/v1/parts/:partId
```

后续管理 API：

```text
PATCH /api/v1/films/:id/favorite
PATCH /api/v1/films/:id/taxonomy
PATCH /api/v1/films/:id/metadata
POST  /api/v1/films/:id/rescan
POST  /api/v1/sources/:id/rescan
POST  /api/v1/scan
DELETE /api/v1/records/:id
```

实际命名应以现有 DTO 和业务边界为准，不要求完全采用上述路径。

## 8. 权限模型

至少区分：

### 8.1 普通访问者

- 查看影片；
- 搜索、排序和筛选；
- 查看详情、标签、类型、分类和演员；
- 播放预览和原片；
- 可选：修改自己的收藏和播放进度。

### 8.2 管理员

- 修改标签、类型、分类和元数据；
- 发起扫描；
- 导入 NFO；
- 删除数据库记录；
- 管理来源；
- 管理设备和服务设置。

### 8.3 桌面端专属操作

以下功能应默认保留在 Electron 桌面端：

- 弹出 Windows 目录选择器；
- 在资源管理器中显示文件；
- 调用服务器电脑的外部播放器；
- 修改局域网监听、安全和服务设置；
- 高风险的真实文件删除操作。

网页可以触发“服务器端扫描已有来源”，但手机浏览器不能使用本机文件选择框去选择服务器电脑上的目录。

## 9. 安全要求

局域网不等于可信环境。实现时必须满足：

1. 局域网模式禁止匿名管理。
2. 首次连接使用短时配对码或桌面端确认。
3. 每台设备使用独立令牌，令牌可撤销。
4. 令牌不能以明文写入日志。
5. 限制登录和配对请求频率。
6. 严格限制 CORS/Origin。
7. 写操作必须防止 CSRF。
8. 所有 ID 最终都由 repository 解析成允许的媒体路径。
9. 防止目录穿越、符号链接越界和任意文件读取。
10. 响应和日志中不要向普通用户暴露完整 Windows 路径。
11. 限制媒体并发、转码并发和单客户端请求频率。
12. 初版明确标记为“仅限受信任局域网”，不支持公网暴露。
13. Electron `BrowserWindow` 继续保持：
    - `nodeIntegration: false`
    - `contextIsolation: true`
    - `sandbox: true`
14. 不把 HTTP 页面赋予 Electron preload 权限。

首版可以在受信任局域网使用 HTTP，但必须提示不要端口转发到公网。局域网 HTTPS、证书和反向代理支持可作为后续增强。

## 10. 网页功能范围

### 10.1 应实现

- 响应式影片网格和表格；
- 搜索、排序、分页；
- 来源、演员、标签、类型、我的分类和状态筛选；
- 影片详情；
- 收藏；
- 标签、类型、分类和元数据管理；
- 单影片和单来源扫描；
- 海报、Fanart 和预览轮播；
- CSV 导出；
- 错误提示和服务诊断信息；
- 手机触控交互。

### 10.2 需要改变桌面交互

- “播放原片”在网页中打开内置播放器，而不是调用 Windows 默认播放器。
- “在资源管理器中显示”只在 Electron 中显示。
- CSV 导出在网页端应通过 HTTP 下载。
- 来源新增优先在桌面端完成。
- Hover Popup 在触摸设备上改为点击或长按触发，不能只依赖鼠标悬浮。

## 11. 视频播放方案

### 11.1 播放优先级

1. 浏览器支持时直接播放原文件。
2. 视频编码兼容但容器或音频不兼容时，实时 Remux/Direct Stream。
3. 视频编码不兼容时，使用 FFmpeg 转码为 HLS。
4. 无法可靠播放时，显示明确诊断，并允许用户在桌面端或 Infuse 中播放。

### 11.2 第一阶段直接播放

第一阶段优先支持：

- HTTP `GET` 和 `HEAD`；
- 单字节范围请求；
- 正确的 `206`、`Content-Range`、`Accept-Ranges`；
- 正确 MIME；
- MP4/H.264/AAC 等浏览器兼容组合；
- 预览视频和原片分开；
- 播放停止后及时释放文件流。

不能仅根据扩展名判断是否可以播放，后续应结合 ffprobe 的容器、视频、音频和字幕信息。

### 11.3 后续 HLS/转码

后续建立独立播放会话：

- 每个会话拥有唯一 ID；
- FFmpeg 进程和缓存目录可追踪；
- 客户端离开或超时后取消任务；
- 限制同时转码数量；
- 相同源文件和兼容参数可复用缓存；
- 缓存有大小、时间和启动清理策略；
- 支持清晰度/码率选择；
- 优先硬件加速，失败时安全回退；
- 支持外部 SRT/VTT；
- ASS/PGS 等字幕根据客户端能力转换或烧录；
- 日志记录 direct play、remux、audio transcode、video transcode 的选择原因。

复杂 HDR、Dolby Vision、DTS/TrueHD/Atmos、PGS 和高码率 4K 可能仍然更适合 Infuse。不要在第一阶段承诺完全替代所有专业播放器能力。

## 12. Infuse 与兼容协议计划

### 12.1 近期

- 网页端作为本项目主要移动客户端。
- Infuse 可继续通过 Windows SMB 访问影片目录。
- 也可以暂时继续运行 Jellyfin，但两边数据库相互独立。

### 12.2 中期可选

- 提供受控 WebDAV，只暴露已登记的影片文件。
- 评估 WebDAV 是否能满足 Infuse 浏览和播放需求。

### 12.3 暂不实施

不在局域网页面首轮中实现 Jellyfin API 兼容。完整兼容至少涉及：

- 用户与设备鉴权；
- 系统信息和能力声明；
- 影片库、项目和分页查询；
- 图片接口；
- 播放能力协商；
- 播放信息与会话；
- Direct Play、Remux、HLS 和转码；
- 字幕和多音轨；
- 观看状态和播放进度；
- Infuse/Jellyfin 版本兼容。

如果未来确认必须让 Infuse读取本项目的分类、收藏和观看状态，应将 Jellyfin 兼容层作为独立的大型里程碑评估。

## 13. 分阶段实施

### 里程碑 A：架构基础与 localhost 只读 MVP

目标：不开放局域网的前提下，先证明浏览器客户端能够通过标准 HTTP 使用同一份数据库。

- 创建功能分支；
- 建立共享应用服务；
- 保留现有 IPC 行为；
- 增加仅监听 `127.0.0.1` 的 HTTP 服务；
- 增加 health/server-info；
- 增加影片分页、详情、筛选项只读 API；
- 增加海报和图片 HTTP 接口；
- 增加最小浏览器入口；
- 验证 Electron 和浏览器读取同一数据库；
- HTTP 服务失败不能影响 Electron；
- 不实现管理写操作；
- 不实现完整转码。

### 里程碑 B：安全局域网只读访问

- 设置中增加启停、端口和监听模式；
- 配对码、设备令牌和撤销；
- 开放局域网监听；
- 显示 IP 地址和二维码；
- 响应式手机页面；
- 浏览器原片 Range 直放；
- Windows 防火墙和错误提示；
- 只读访问审计日志。

### 里程碑 C：网页管理

- 管理员权限；
- 收藏、标签、类型和我的分类；
- NFO 摘要和演员筛选；
- 单影片、单来源和整库扫描；
- CSV 下载；
- 批量修改与记录删除；
- 高风险操作二次确认；
- 保持用户编辑保护和禁止写回 NFO。

### 里程碑 D：完整播放管线

- ffprobe 能力检测；
- Remux；
- HLS；
- 音频和视频转码；
- 字幕；
- 播放进度；
- 转码并发、取消、缓存和诊断；
- 桌面与移动浏览器兼容测试。

### 里程碑 E：产品化

- 托盘和后台服务；
- PWA；
- 已配对设备管理；
- 服务状态页面；
- 网络变化、休眠和恢复处理；
- 完整安装包和升级验证。

### 里程碑 F：可选 Infuse 协议

- WebDAV 可行性验证；
- 根据真实需求决定是否评估 Jellyfin 兼容层。

## 14. 首轮验收标准

里程碑 A 完成时必须满足：

1. Electron 桌面端现有功能没有回归。
2. 打包后的 Electron 仍通过本地文件加载，不依赖 HTTP 服务。
3. HTTP 服务只监听 `127.0.0.1`。
4. 浏览器能查看影片列表、筛选条件、详情和图片。
5. Electron 与浏览器显示相同的数据库内容。
6. 浏览器不能读取任意磁盘路径。
7. 关闭 HTTP 服务不影响 Electron。
8. 端口被占用时有清晰日志和界面诊断。
9. 类型检查、Lint 和已有测试通过。
10. 新增 API、路径校验、Range 或服务生命周期测试。
11. 没有修改外部 NFO。
12. 没有加入 Jellyfin 协议兼容或不受控公网访问。

里程碑 B 完成时额外满足：

1. 未配对设备不能读取影片库。
2. 手机可完成配对并浏览影片。
3. 服务地址和端口显示正确。
4. 局域网关闭后端口不再监听。
5. 普通用户不能调用管理 API。
6. MP4 等兼容影片支持拖动进度。

## 15. 测试计划

至少覆盖：

- HTTP 服务启动、停止、重复启动和端口占用；
- localhost 与 LAN 监听边界；
- 配对码过期、令牌撤销和权限拒绝；
- API 参数校验和分页；
- 影片不存在、资源不存在；
- 任意路径和目录穿越攻击；
- `GET`、`HEAD`、Range、无效 Range；
- Electron IPC 与 HTTP 返回关键 DTO 的一致性；
- 服务异常不导致数据库或桌面端退出；
- 扫描进行中读取；
- 关闭窗口、托盘退出、程序退出和数据库关闭顺序；
- 手机宽度下的核心页面布局；
- 播放结束、路由切换和断开连接后的资源释放。

## 16. 实施原则

- 每个里程碑先检查真实代码，再做最小范围修改。
- 不复制 repository 或扫描逻辑。
- 不允许 HTTP handler 直接信任客户端路径。
- 不破坏当前严格按文件名识别影片和仅 `-cd1/-cd2/...` 合并分段的规则。
- 不改变标签、类型、用户编辑保护和 NFO 覆盖规则。
- 不写回外部 NFO。
- 不影响现有打包、自动 Release 和版本规则。
- 不为了网页端删除 Electron 专属功能。
- 每个阶段都必须先验证，再继续扩大范围。

## 17. 新 Codex 任务启动提示词

将下面提示词复制到以本项目为工作目录的新 Codex 任务中：

```text
请继续修改当前 Electron 本地影片管理项目。

项目目录：
E:\code\zzg_movies_electron

本轮开始局域网网页访问改造。请先完整阅读：
E:\code\zzg_movies_electron\docs\LAN_WEB_ACCESS_PLAN.md

必须先检查当前真实代码、git 状态、现有测试和打包架构，不要只依据文档猜测。确认基线后创建并切换到功能分支：
codex/lan-access

本轮只完成文档中的“里程碑 A：架构基础与 localhost 只读 MVP”，不要提前实现完整局域网开放、网页管理写操作、HLS 转码、WebDAV 或 Jellyfin API 兼容。

核心要求：

1. 保留现有 Electron 桌面端及 preload/IPC 行为，正式版 BrowserWindow 继续加载本地打包页面，不依赖 HTTP 服务。
2. 从现有 IPC handler 中增量抽取共享业务服务，使 IPC 和 HTTP 复用同一套 repository、扫描规则、DTO 和数据验证；禁止复制业务规则。
3. 在 Electron 主进程增加可独立启停的 HTTP 服务，里程碑 A 只能监听 127.0.0.1。
4. HTTP 服务启动失败、端口占用或路由异常不能导致 Electron 桌面端无法启动。
5. 实现最小只读 API：health、server-info、影片分页、影片详情、筛选数据、分类、标签、类型、演员和来源。
6. 实现海报及图片的标准 HTTP GET/HEAD 接口。只能通过数据库 ID 解析资源，禁止接收或暴露任意磁盘路径。
7. 建立浏览器可用的客户端传输层和最小网页入口，让普通浏览器可以查看影片列表、筛选、详情和图片。
8. Electron 客户端和 HTTP 客户端应逐步依赖统一 FilmLibraryClient 接口；不要一次性重写全部现有页面。
9. 保持当前数据库、扫描、文件名匹配、分段识别、NFO、标签、类型、用户编辑保护和“禁止写回外部 NFO”规则完全不变。
10. 不新增 Jellyfin、WebDAV、DLNA、SMB 服务，不实现公网访问，不实现管理写 API，不实现完整视频转码。
11. 为 HTTP 生命周期、API 参数、资源路径安全和关键 DTO 一致性增加测试。
12. 完成后运行 typecheck、lint 和测试；修复由本次改造造成的问题。
13. 不覆盖用户已有改动，不做 git reset --hard 等破坏性操作。

开始前先给出简短实施计划，然后直接执行。完成后明确汇报：

- 实际修改的架构；
- 新增 API 和访问地址；
- Electron 与网页如何共用数据库和业务服务；
- 安全边界；
- 测试结果；
- 尚未进入的后续里程碑；
- 关键文件路径。
```
