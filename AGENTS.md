# AGENTS.md — 开发约定

> 本文件是 AI 与人类开发者的第一入口，先读这里再看其他文档。

## 一、沟通要求
- **永远使用中文**回复，思考过程也用中文。
- 写代码前先给「改动前总结」，写完后给「改动后总结」。
- 不确定的需求先提问确认，不要自行假设。
- 每步代码都要写中文注释，说明**实现了什么**和**为什么这样实现**。

## 二、项目文档规则
根目录只允许存放这几个 md：
- `AGENTS.md`（本文件）
- `CHANGELOG.md`（变更日志，北京时间）
- `DEVTIPS.md`（长期开发提示）
- `PROJECT_PLAN.md`（项目方案）
- `DEPLOY_CREDENTIALS.md`（部署凭据）

其余文档一律放 `docs/`。

## 三、代码组织规则
```
apps/app         ReactLynx 客户端（安卓/iOS/鸿蒙）
apps/web         网页版（ReactLynx Web）
apps/desktop     Electron 桌面端（Win/macOS）
apps/server      Fastify 后端 + WS + 通话信令
packages/shared  前后端共享类型/校验/常量（唯一契约真相源）
```

- 不允许跨层直接引用（`apps/*` 之间不能互相 import，只能通过 `@chat/shared`）。
- 新增接口必须先改 `packages/shared`，再改后端，最后改客户端。
- 数据库变更必须走 `drizzle-kit generate` 生成迁移文件，不允许手写 DDL 后不提交迁移。

## 四、编译铁律
- **服务器（2C1.8G）绝不做任何编译**，所有产物由 GitHub Actions 构建。
- 服务器只负责运行 `apps/server` 的产物与托管静态文件。
- 任何需要 `npm run build` 的操作都必须写进 `.github/workflows/`。

## 五、安全铁律
- 密钥只放 `.env`（已 gitignore）或 GitHub Secrets，绝不写进代码。
- 密码、验证码、令牌明文禁止写入日志。
- 所有用户输入必须经 zod 校验。
- SQL 必须参数化，禁止字符串拼接。

## 六、SSH
- 服务器已配置免密，不需要输入密码。
- 如发现未免密，明确提示用户添加，**不要尝试输入明文密码**（会被拦截导致对话中断）。
