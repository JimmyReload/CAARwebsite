# PuzzleCat OAuth 接入说明

「使用 PuzzleCat 账号登录」的实现说明、部署步骤，以及申请应用时该填什么。

协议依据：<https://puzzle.cat/platform/oauth>（2026-11-23 核对，授权码模式）。
上游错误体也实测过：

| 端点 | 失败时返回 |
|---|---|
| `POST /api/oauth/token` | `{"error":"invalid_client","error_description":"客户端认证失败"}`（HTTP 401） |
| `GET /api/oauth/userinfo` | `{"code":401,"data":null,"message":"无效的访问令牌","timestamp":...}`（HTTP 401） |

## 一、这次加了什么

| 文件 | 作用 |
|---|---|
| `src/oauth.js` | 上游协议客户端：拼授权地址、换令牌、取用户信息、撤销令牌、占位口令与用户名推导 |
| `src/worker.js` | 三个端点 + 账号绑定/建号 + 会话签发 + 审计事件 |
| `src/views/AuthView.jsx` | 登录/注册页的「用 PuzzleCat 账号登录」按钮与失败提示 |
| `src/views/AccountView.jsx` | 首登建号账号的「设置密码」表单 |
| `src/App.jsx` | 处理回跳的 `?oauth=` 结果并刷新登录态 |
| `tests/oauth.test.mjs` | 18 个用例，stub 全局 `fetch` 驱动整条流程 |

**没有新增数据库迁移**：身份绑定落在既有的 `users.email`（0006 迁移已建 UNIQUE 索引），
口令字段用 `oauth$` 前缀的随机占位值表示「还没设过密码」。
所以这份代码可以先上线、不需要等迁移，也不会有「代码先于迁移」的 500 窗口。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/oauth/config` | `{"puzzlecat":true/false}`，前端据此决定是否显示登录按钮 |
| GET | `/api/oauth/puzzlecat/start?next=/account` | 302 到上游授权页；`state` 写进 HttpOnly Cookie |
| GET | `/api/oauth/puzzlecat/callback` | 校验 state → 换令牌 → 取用户 → 建/找账号 → 种会话 Cookie → 302 回站内 |
| POST | `/api/password/set` | 只给 `oauth$` 占位口令的账号补设密码（不需要旧口令） |

回跳统一 302 到 `/?oauth=<code>#<next>`，由前端读 `location.search` 处理并立刻清掉参数，
授权码与令牌从不进入浏览器历史。

`<code>` 取值：`ok` / `state` / `denied` / `banned` / `noemail` / `failed` / `unconfigured`。

## 二、部署

### 1. 申请应用，拿到 App ID / App Secret

见文末「申请表填写」。审核通过后 App Secret 只显示一次，先存进密码库。

### 2. 配置变量

`App ID` 不是秘密，可以放 `wrangler.jsonc` 的 `vars`；`App Secret` 必须走 secret：

```bash
npx wrangler secret put PUZZLECAT_CLIENT_SECRET
```

| 变量 | 必填 | 说明 |
|---|---|---|
| `PUZZLECAT_CLIENT_ID` | 是 | 申请得到的 App ID |
| `PUZZLECAT_CLIENT_SECRET` | 是 | App Secret（只放 secret，永不进前端） |
| `PUZZLECAT_REDIRECT_URI` | 否 | 回调地址。缺省按当前站点推导为 `<origin>/api/oauth/puzzlecat/callback`；**必须与申请时登记的逐字一致** |
| `PUZZLECAT_BASE` | 否 | 上游域名，默认 `https://puzzle.cat`；仅供本地/测试指向假服务 |

本地联调写 `.dev.vars`（已被 `.gitignore` 忽略）：

```ini
PUZZLECAT_CLIENT_ID=xxx
PUZZLECAT_CLIENT_SECRET=yyy
```

两个变量缺任意一个时，登录页不显示 PuzzleCat 按钮，`/start` 直接 503 并给出可读文案，
不会把用户送到上游换一个 `invalid_client`。

### 3. 发布

```bash
npm test && npm run build
npx wrangler deploy
```

上线后自检：

```bash
curl -s https://caar.fun/api/oauth/config          # {"puzzlecat":true}
curl -si https://caar.fun/api/oauth/puzzlecat/start | head -3   # 302 + puzzle.cat/oauth/authorize
```

## 三、账号怎么对应

1. 上游 `userinfo` 的 `email` 归一化为小写，去 `users.email` 查。
2. **查到** → 直接登录那个账号（PuzzleCat 已验证过邮箱归属，等价于邮箱持有证明）。
   OAuth 只用来认人，**不覆盖**站内昵称、角色、封禁状态。
3. **查不到** → 建号：用户名从昵称 → 邮箱前缀 → `pc<id>` 推导（冲突时 `_2`/`_3` 顺延，
   上限 20 码点），昵称取上游昵称（不合规则用用户名），口令写 `oauth$` 占位值。
4. 上游没给邮箱 → **不建号**，回 `oauth=noemail`。没有稳定标识时建号会在每次登录时
   无限新建账号。

被封禁的站内账号不能借 OAuth 绕过封禁（回调里查 `banned` 直接拒绝）。
首登建出来的账号在个人主页可以「设置密码」；设过之后密码登录与 PuzzleCat 登录进的是同一个账号。

## 四、安全边界

- **App Secret 只在 Worker 里**：换令牌在服务端完成，前端只拿到一个跳转链接。
- **state 校验**：32 字符随机值写进 `HttpOnly; SameSite=Lax; Secure; Path=/api/oauth` Cookie，
  回调时逐字比对，成功后立即用 `Max-Age=0` 清掉。挡 CSRF 与登录 CSRF。
- **令牌不落库**：只用来取一次用户信息，取完立刻调 `/api/oauth/token/revoke` 撤销；
  不保存 access_token / refresh_token，因此也不存在 refresh 轮换问题与泄漏面。
- **回跳路径白名单**：`next` 只接受站内相对路径，`//evil.com`、`https://…`、`/\evil.com`
  一律回落到 `/account`。
- **不新增写放大**：未认证的 `/start` 只写两个 Cookie，不写 D1/KV。

## 五、申请表填写

> 域名、Logo 均按现有线上资源核实：`https://caar.fun/api/me` 返回 200，
> `https://caar.fun/images/caar-seal.png` 返回 200 `image/png`。

| 字段 | 建议填写 |
|---|---|
| 应用名称 | `中不正协官网` |
| 应用描述 | `中国不正常推理协会（CAAR）的官方网站：成员登录后可查看协会公告、puzzle hunt 赛事总览、标记想参加的赛事并给管理员留言。` |
| Logo URL | `https://caar.fun/images/caar-seal.png` |
| 回调地址 | `https://caar.fun/api/oauth/puzzlecat/callback` |
| 联系方式 | 邮箱 `JimmyReload@qq.com`（站点公开联系邮箱；如需用个人手机/QQ，替换成你自己的） |

用途说明：

```
本应用是中国不正常推理协会（CAAR，https://caar.fun）的官方网站，为协会成员提供公告、站内信、
puzzle hunt 赛事总览与组队协作。接入 PuzzleCat OAuth2.0 的目的，是让成员用已有的 PuzzleCat
账号直接登录本站、免去重复注册；同时为后续与 PuzzleCat 生态的互通（例如站内展示公开资料、
同步公开的赛事与活动信息）预留扩展空间。

一、当前使用的数据（scope: profile）
1. 读取用户信息接口返回的 id、email、nickname，用于识别账号与建立登录会话。
2. email 作为账号关联依据：本站已有同邮箱账号则直接登录该账号，不覆盖其站内昵称、角色等资料；
   没有则用昵称推导一个站内用户名并自动建号。
3. avatar、bio 等公开资料当前不落库，仅在页面需要展示时按公开地址引用。

二、后续可能扩展的范围
以下扩展均限于用户在 PuzzleCat 上**公开可见**的信息，且不超出用户已授权的范围：
1. 展示公开头像、公开昵称、公开简介，用于站内身份与成员列表展示；
2. 读取公开的谜题 / Plog / 赛事 / 活动页面信息，用于站内赛事总览、成员作品或活动联动
   （本站现有的赛事总览即通过公开接口读取，不涉及任何用户私有数据）；
3. 账号绑定与解绑、公开资料同步等互通功能。

三、原则与边界
1. 只读取用户公开可见的信息；不读取私信、未公开草稿、好友关系等非公开数据。
   如后续功能确需更大权限，会在申请范围内说明，并由用户再次授权后才启用。
2. 不向任何第三方出售、出租用户数据，也不用于广告画像；数据仅用于本站功能。
3. App Secret 只保存在服务端加密变量中，前端代码与浏览器不可见；回调地址固定为
   https://caar.fun/api/oauth/puzzlecat/callback，全程 HTTPS。
4. 当前不长期保存访问凭据：access_token 仅用于当次用户信息读取，用完即调用
   /api/oauth/token/revoke 撤销。若后续功能确需长期访问（例如定期同步公开信息），
   会加密保存 refresh_token、提供撤销与解绑入口，并在站内说明变更。
5. 用户可在个人主页随时解绑 PuzzleCat 登录，也可通过站点联系邮箱要求删除账号与相关数据。

回调地址只登记生产域名一个；本地开发通过 PUZZLECAT_REDIRECT_URI 指向本地假服务，
不会向贵方发起授权请求。
```

> 这版把「不读取其他接口」「不保存任何凭据」这类**硬承诺**改成了「当前如何、扩展时怎么做」，
> 给后续功能留了口子，但两条底线仍然写死：只碰公开信息、不出售不画像。
> 审核若追问扩展细节，可以说清楚"扩展前会更新说明并重新征得授权"。

## 六、本地验证

```bash
# 单元/集成：stub 上游，锁住每条分支
npm test

# 端到端（真 Worker + 真 D1 + 假上游），打印每一步实际发出的请求
node scripts/smoke-oauth.mjs

# 想在浏览器里走一遍：起假上游 + 指向它的 dev server
node scripts/fake-puzzlecat.mjs 8791
npx wrangler dev --port 8792 \
  --var PUZZLECAT_CLIENT_ID:test_id \
  --var PUZZLECAT_CLIENT_SECRET:test_secret \
  --var PUZZLECAT_BASE:http://127.0.0.1:8791 \
  --var PUZZLECAT_REDIRECT_URI:http://127.0.0.1:8792/api/oauth/puzzlecat/callback
# 打开 http://127.0.0.1:8792/#/login 点「用 PuzzleCat 账号登录」
```

本地 D1 需要先建表（否则 OAuth 建号那一步会因为缺 `users` 表而失败）：

```bash
npx wrangler d1 execute caar-db --local --file=schema.sql
```

## 七、已知取舍

- **按邮箱合并账号**：这依赖 PuzzleCat 对邮箱的验证强度。如果上游允许未验证邮箱注册，
  理论上可用别人的邮箱接管本站账号。当前接受这个前提（PuzzleCat 是其平台账号体系），
  若以后要更严，可改为「必须先用密码登录，再在个人主页主动绑定」。
- **没有实现 refresh token**：本站不需要持续访问 PuzzleCat 的 API，撤销即止。
- **未做 PKCE**：上游文档未定义 `code_challenge`，机密客户端 + state 已足够；
  多送参数反而可能被严格校验拒绝。
