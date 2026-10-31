# 发布到公网

现在这份能在一台笔记本上跑，地址是 `127.0.0.1:8899` 或者局域网 IP。
要让别人打开网页就能玩，把它交给一个免费托管就行。

## 准备的样子

项目根目录已经有：

- `package.json` —— 声明了 `npm start` 和唯一的依赖 `ws`
- `server.js` —— 端口读 `process.env.PORT`，监听 `0.0.0.0`，托管的转发能进来
- `.gitignore` —— 不会把 `node_modules` 和下载的工具传上去

## 两步

### 一、传到 GitHub

1. github.com 注册（邮箱即可，免费）
2. 右上角 `+` → New repository → 名字随便，比如 `literature-kill`，选 Public
3. 建好后在仓库页面点 `uploading an existing file`，把这一整个文件夹拖进去
   （拖的时候跳过 `node_modules`、`tools/` 里的 exe 和 msi，`.gitignore` 已经挡住了）
4. 点 Commit

### 二、在 Render 上开服务

1. render.com 注册（用 GitHub 账号登录最省事）
2. Dashboard → `New +` → `Web Service`
3. 选刚才那个仓库
4. 填这三样：
   - Runtime：Node
   - Build Command：`npm install`
   - Start Command：`npm start`
5. 选 Free 那个规格 → Create Web Service

几分钟后会给你一个 `https://xxx.onrender.com` 的地址，那个就是发布出来的入口。

## 免费档要知道的

- 一段时间没人访问，实例会睡下去；第一个人点开要等二三十秒才醒
- 服务重启，房间里的局就没了（状态在内存里）
- WebSocket 走 wss，托管那边默认支持，不用另外配

## 想一直醒着

付费规格最省事。另一条路是用一台常开的机器（家里的旧电脑也行）跑 `npm start`，
再用 cloudflared 或 Tailscale 给它一个外面的入口——那是现在这套的做法。
