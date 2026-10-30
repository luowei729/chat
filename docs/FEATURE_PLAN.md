# chat 功能规划（Telegram 级）

> 目标：从「能聊天」升级为「完整可用的聊天 App」。
> 原则：**后端先行、前端跟随、每阶段可验证**。

---

## 一、现状盘点

### 后端已有
| 模块 | 接口 |
|---|---|
| auth | 注册 / 登录 / 刷新 / 登出 / 改密 / 邮箱验证码 |
| user | `GET /me`、`PATCH /me`、`GET /users/:id`、`GET /users/search` |
| conversation | 列表 / 详情 / 建私聊 / 建群 / 置顶静音 / 改群信息 |
| message | 拉历史 / 发消息 / 撤回 |
| upload | 内容寻址上传 + X-Accel-Redirect 下发 |
| call | ICE 配置 + P2P Mesh 信令 |
| invite | 邀请码校验 / 使用记录 |

### 后端缺失（本规划要补）
- ❌ **好友关系**（请求 / 接受 / 拒绝 / 删除 / 拉黑）
- ❌ **联系人备注名**（对好友设置自定义名称）
- ❌ **群成员管理**（邀请 / 移除 / 退群 / 设管理员 / 转让群主）
- ❌ **消息表情回应**
- ❌ **消息转发**
- ❌ **已读成员明细**（谁读到哪了）

### 前端已有页面
Login / Register / ResetPassword / Conversations / Chat / Call / Invite / Profile / NewChat

### 前端缺失页面
- ❌ 通讯录（好友列表，带备注名）
- ❌ 好友请求（收到 / 发出）
- ❌ 他人资料页（加好友 / 发消息 / 拉黑）
- ❌ 群信息页（成员管理）
- ❌ 编辑资料（头像 / 昵称 / 签名）
- ❌ 设置页

---

## 二、阶段划分

### 阶段 1：好友体系（核心，优先）
**数据库**
- `friendships`：`userId`、`friendId`、`status`(pending/accepted/blocked)、`requesterId`、`createdAt`、`acceptedAt`
  - 双向存两条记录（A→B、B→A），便于双向查询与单向拉黑
- `contact_remarks`：`ownerId`、`targetId`、`remark` —— 备注名独立于好友关系，删好友不丢备注

**接口**
```
GET    /friends                     好友列表（含备注名、在线状态）
GET    /friends/requests            待处理请求（收到 + 发出）
POST   /friends/request             发起好友请求 { userId }
POST   /friends/accept              接受 { userId }
POST   /friends/reject              拒绝 { userId }
DELETE /friends/:userId             删除好友
POST   /friends/block               拉黑 { userId }
DELETE /friends/block/:userId       取消拉黑
PUT    /contacts/:userId/remark     设置备注名 { remark }
```

**WebSocket 事件**
- `friend.request` / `friend.accepted` / `friend.removed`

**前端**
- 新增「通讯录」页（Tab）
- 新增「好友请求」页
- 新增「他人资料」页（备注名编辑、加好友、发消息）
- 会话列表顶部增加「通讯录」入口

---

### 阶段 2：群聊完善
**接口**
```
GET    /conversations/:id/members        成员列表（含角色、在线）
POST   /conversations/:id/members        邀请成员 { userIds[] }
DELETE /conversations/:id/members/:uid   移除成员（需 admin+）
POST   /conversations/:id/leave          退出群聊
PATCH  /conversations/:id/members/:uid   设/取消管理员 { role }
POST   /conversations/:id/transfer       转让群主 { userId }
```

**前端**
- 群信息页：群名 / 头像 / 成员网格 / 邀请 / 移除 / 退群
- 建群时可选好友（而非搜索）

---

### 阶段 3：消息增强
**数据库**
- `message_reactions`：`messageId`、`userId`、`emoji`、`createdAt`

**接口**
```
POST   /messages/:id/reactions       添加回应 { emoji }
DELETE /messages/:id/reactions/:emoji 取消回应
POST   /messages/:id/forward         转发到多个会话 { conversationIds[] }
GET    /conversations/:id/reads      已读明细
```

**前端**
- 长按消息 → 操作菜单（回复 / 转发 / 复制 / 撤回 / 表情回应）
- 消息气泡下方显示回应
- 群聊已读人数

---

### 阶段 4：资料与设置
**接口**
```
PUT    /me/avatar            上传头像
PUT    /me/profile           昵称 / 签名
GET    /me/settings          隐私设置
PUT    /me/settings          更新设置
```

**前端**
- 编辑资料页（头像裁剪、昵称、签名）
- 设置页（隐私、通知、退出登录、注销账号）

---

## 三、关键设计决策

### 1. 好友关系为什么双向存两条
单条记录（A,B 有序对）查「我的好友」要 `WHERE a=me OR b=me`，
双向两条可以只查 `WHERE userId=me`，配合索引 `idx_friendships_user` 效率更高，
且天然支持「我拉黑他但他没拉黑我」这种单向状态。

### 2. 备注名独立成表
- 删好友后重新加，备注还在（符合直觉）
- 未来可扩展到群昵称（`scope` 字段区分）

### 3. 前端布局约束（血泪教训）
本项目 Lynx 集成下：
- `scroll-view` / `list` **不能做页面主滚动容器**（内容会空白且不报错）
- 长列表用分页加载 + 纯 `view` 布局
- 所有长度必须带单位字符串（`'16px'`）
- 容器必须显式 `display:'flex' + flexDirection:'column'`（view 默认行向）

### 4. 开发验证流程
```bash
chatdev              # 改前端：9 秒出截图
chatdev --apk        # 改原生：20 秒
```
截图固定落在 `/tmp/last.png`。

---

## 四、验收清单

每个阶段完成后必须验证：
- [ ] 页面能正常渲染（截图确认）
- [ ] 主流程走通（真机点击操作，非仅接口测试）
- [ ] 错误提示准确（不吞异常）
- [ ] 无 Lynx 渲染错误（`adb logcat | grep LynxError`）

---

## 五、长期（不在本次范围）
- 视频通话（需 SFU + 服务器升级）
- 消息端到端加密
- 多端同步增量拉取（当前是全量刷新）
- 消息全文搜索（MySQL 全文索引）
