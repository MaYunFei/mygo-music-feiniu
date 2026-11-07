# MyGo Music 飞牛音乐插件

把飞牛 NAS（fnOS）自带的**飞牛音乐**接入 [MyGo Music](https://github.com/egoist/mygo-music)。曲库、封面、歌词、收藏、歌单和音频流都来自你自己的 NAS。

## 功能

- 账号登录（用户名 / 密码，支持可选的远程访问安全码）
- 首页：最近添加、最近播放、我喜欢的、专辑、歌单、歌手
- 全部歌曲、专辑、歌手、歌单、最近播放、风格
- 搜索歌曲、专辑、歌手、歌单
- 专辑 / 歌手 / 歌单详情页
- 收藏与取消收藏、我喜欢的
- 歌单新建、改名、删除、添加歌曲、移除歌曲
- LRC 歌词
- 原始音频流（MP3 / FLAC / Ogg Vorbis / WAV / M4A / AAC）
- 随机漫游电台
- 中文 / English 界面

## 安装

### 从本地文件夹（开发时）

1. 打开 MyGo Music → **设置 → 插件 → +**
2. 选择**从文件夹安装**，选中本目录（包含 `plugin.json` 的那一层）
3. 在插件设置里填写服务器地址、用户名、密码
4. 点**登录**

也可以把整个目录打成 zip 后从 zip 安装。

### 从 GitHub 安装（发布后）

仓库根目录放 `plugin.json` 和 `index.js` 即可。MyGo Music 会取最新 release（或默认分支最新提交）：

```
mygo-music://install-plugin?repo=你的用户名/mygo-music-feiniu
```

给仓库加上 GitHub topic `mygo-music-plugin`，就会出现在官方插件页 <https://mygo-music.egoist.dev/plugins>。

## 设置

| 设置 | 说明 |
| --- | --- |
| 服务器地址 | 例如 `http://192.168.1.10:5666` 或 `https://nas.example.com`。可以带 `/music/api/v1` 后缀，会自动去掉 |
| 用户名 | 有曲库权限的飞牛音乐账号 |
| 密码 | 登录时用 SHA-256 哈希后发送；MyGo Music 会在本机保存插件设置 |
| 安全码 | 可选。只在飞牛里开启了远程访问安全码时填写 |

建议为插件单独建一个飞牛账号，并优先在局域网或 HTTPS 反向代理下使用。`http://` 会把密码哈希和登录令牌明文放在网络里。

## 权限说明

`plugin.json` 申请了 `network: ["*"]`，因为每个人的 NAS 地址都不一样，包括内网 IP 和自定义域名。插件只会向你填写的服务器地址发请求。

`requestHeaders` 让 MyGo Music 在取封面和音频时自动带上 `music-token` Cookie —— 这两类请求由播放器自己发出，插件无法插手，所以必须在 `plugin.json` 里声明。

## 已知限制

飞牛音乐没有提供这些接口，所以插件里也没有对应功能：

- 评论
- 播客 / 有声书
- 收藏专辑、关注歌手
- 调整歌单内歌曲顺序（只能添加 / 移除）
- 歌词翻译（只取首选歌词）
- 播放 DSF、APE、WMA、Opus 等格式：飞牛只能把它们转成 HLS，而 MyGo Music 的播放器不支持 HLS，所以这类歌会显示为不可播放
- 按音质转码：`standard` / `high` 也会直接播放原始文件

另外：

- 首页和各列表页一次最多取 300 首（MyGo 的 `browse` 页面没有分页）

## 开发

插件是一个 ES module，由 MyGo Music 的 JavaScript 运行时执行，不需要 Node 依赖。

```bash
node --test
```

测试用 mock 的 `host` 和 `fetch` 覆盖登录、映射、分页、收藏、歌词、转码和 401 处理。

## 参考与致谢

飞牛音乐没有公开 API 文档。本插件的 `/music/api/v1/*` 接口、参数和返回结构，是在下面这些开源项目的基础上整理出来的。**本插件没有复制它们的源代码**，只参考了接口事实和实现思路。

| 项目 | 参考了什么 | 许可证 |
| --- | --- | --- |
| [kuilei0926/FeiNiuMusic](https://github.com/kuilei0926/FeiNiuMusic) | 登录流程、曲库 / 搜索 / 歌单 / 收藏 / 歌词 / 漫游接口、音频流与封面的认证方式 | 未声明（基于 [NagoMusic](https://github.com/Keduoli03/NagoMusic)） |
| [qianlipp/fn-music-bridge](https://github.com/qianlipp/fn-music-bridge) | 路由表，用来交叉核对接口路径和查询参数 | AGPL-3.0 |
| [egoist/mygo-music](https://github.com/egoist/mygo-music) | 插件 API、`host` 能力、[示例插件](https://github.com/egoist/mygo-music/tree/main/examples/demo-plugin) | AGPL-3.0 |
| [rocona/mygo-navidrome](https://github.com/rocona/mygo-navidrome) | 自建音乐服务器插件的结构参考：设置、首页、分页、登录失效处理 | 未声明 |

如果飞牛更新后接口有变化，优先对照 FeiNiuMusic 和 fn-music-bridge 的最新代码。

> 本插件目前没有引入上述项目的代码。如果以后要复制它们的实现，需要按对应许可证处理；其中 fn-music-bridge 和 MyGo Music 是 AGPL-3.0。

## 发布

1. 建一个公开 GitHub 仓库，把本目录内容推到根目录
2. 打 tag / 发 release（可选，MyGo Music 也接受默认分支最新提交）
3. 仓库加 topic `mygo-music-plugin`
4. 在 README 放安装按钮：

```markdown
[![Install in MyGo Music](https://img.shields.io/badge/MyGo%20Music-Install-4f46e5)](mygo-music://install-plugin?repo=你的用户名/mygo-music-feiniu)
```

## 许可

插件代码可自行选择许可证；MyGo Music 本体是 AGPL-3.0。
