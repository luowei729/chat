/**
 * ============================================================
 * 业务错误码
 * ------------------------------------------------------------
 * 为什么不用 HTTP 状态码表达一切：
 * 1. 前端需要区分「密码错」和「账号被封」，两者都是 401；
 * 2. 错误码是稳定契约，文案可以随时改，码不能改；
 * 3. 便于日志聚合与监控告警（按码统计）。
 *
 * 编码规则：5 位数字，前 2 位为模块，后 3 位为该模块内序号。
 *   10xxx 通用   11xxx 认证   12xxx 邀请   13xxx 会话
 *   14xxx 消息   15xxx 上传   16xxx 通话   17xxx 限流
 * ============================================================
 */

export const ErrorCode = {
  /** 成功（与 ApiOk.code 一致） */
  OK: 0,

  /* ---------- 通用 10xxx ---------- */
  INTERNAL_ERROR: 10000,
  BAD_REQUEST: 10001,
  UNAUTHORIZED: 10002,
  FORBIDDEN: 10003,
  NOT_FOUND: 10004,
  VALIDATION_FAILED: 10005,
  PAYLOAD_TOO_LARGE: 10006,
  UNSUPPORTED_MEDIA_TYPE: 10007,
  CONFLICT: 10008,
  /** 服务端时间与客户端偏差过大（防重放） */
  CLOCK_SKEW: 10009,

  /* ---------- 认证 11xxx ---------- */
  EMAIL_INVALID: 11001,
  EMAIL_ALREADY_REGISTERED: 11002,
  EMAIL_CODE_INVALID: 11003,
  EMAIL_CODE_EXPIRED: 11004,
  EMAIL_CODE_TOO_MANY_ATTEMPTS: 11005,
  EMAIL_SEND_FAILED: 11006,
  PASSWORD_WEAK: 11007,
  CREDENTIALS_INVALID: 11008,
  ACCOUNT_DISABLED: 11009,
  TOKEN_INVALID: 11010,
  TOKEN_EXPIRED: 11011,
  REFRESH_TOKEN_REVOKED: 11012,
  /** 注册时未填写邀请码 */
  INVITE_REQUIRED: 11013,

  /* ---------- 邀请 12xxx ---------- */
  INVITE_CODE_NOT_FOUND: 12001,
  INVITE_CODE_EXHAUSTED: 12002,
  INVITE_CODE_EXPIRED: 12003,
  INVITE_QUOTA_EXCEEDED: 12004,

  /* ---------- 会话 13xxx ---------- */
  CONVERSATION_NOT_FOUND: 13001,
  NOT_A_MEMBER: 13002,
  CANNOT_CHAT_WITH_SELF: 13003,
  GROUP_MEMBER_LIMIT: 13004,
  NOT_GROUP_OWNER: 13005,
  MEMBER_NOT_FOUND: 13006,

  /* ---------- 消息 14xxx ---------- */
  MESSAGE_NOT_FOUND: 14001,
  MESSAGE_TOO_LONG: 14002,
  MESSAGE_EMPTY: 14003,
  /** 无权删除他人消息 */
  MESSAGE_DELETE_FORBIDDEN: 14004,
  /** 引用回复的目标消息不存在或不在同一会话 */
  REPLY_TARGET_INVALID: 14005,
  /** 回应目标消息不存在 */
  REACTION_TARGET_INVALID: 14006,

  /* ---------- 好友 18xxx ---------- */
  /** 不能加自己为好友 */
  FRIEND_SELF: 18001,
  /** 已经是好友 */
  FRIEND_ALREADY: 18002,
  /** 对方已向你发出请求，请直接接受 */
  FRIEND_REQUEST_PENDING_INCOMING: 18003,
  /** 已发出请求，等待对方处理 */
  FRIEND_REQUEST_PENDING_OUTGOING: 18004,
  /** 好友请求不存在 */
  FRIEND_REQUEST_NOT_FOUND: 18005,
  /** 不是好友关系 */
  FRIEND_NOT_FOUND: 18006,
  /** 已被对方拉黑 */
  FRIEND_BLOCKED_BY_PEER: 18007,
  /** 你已拉黑对方，需先解除 */
  FRIEND_BLOCKED_BY_SELF: 18008,

  /* ---------- 群组管理 19xxx ---------- */
  /** 权限不足（需要管理员或群主） */
  GROUP_PERMISSION_DENIED: 19001,
  /** 群主不能退群，需先转让 */
  GROUP_OWNER_CANNOT_LEAVE: 19002,
  /** 目标用户已在群内 */
  GROUP_MEMBER_EXISTS: 19003,
  /** 群成员已达上限 */
  GROUP_MEMBER_LIMIT_REACHED: 19004,
  /** 不能对自己执行该操作 */
  GROUP_OPERATION_ON_SELF: 19005,

  /* ---------- 上传 15xxx ---------- */
  FILE_TOO_LARGE: 15001,
  FILE_TYPE_NOT_ALLOWED: 15002,
  ATTACHMENT_NOT_FOUND: 15003,
  /** 附件已被其他消息引用，禁止重复绑定 */
  ATTACHMENT_ALREADY_BOUND: 15004,
  UPLOAD_INCOMPLETE: 15005,
  /** 文件超过保留期（聊天文件仅存 30 天），服务器已删除文件本体 */
  ATTACHMENT_EXPIRED: 15006,

  /* ---------- 通话 16xxx ---------- */
  CALL_NOT_FOUND: 16001,
  CALL_ALREADY_ENDED: 16002,
  CALL_PARTICIPANT_LIMIT: 16003,
  CALL_STATE_INVALID: 16004,

  /* ---------- 限流 17xxx ---------- */
  RATE_LIMITED: 17001,
  TOO_MANY_REQUESTS: 17002,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * 错误码 → 默认中文文案
 * 说明：服务端可以覆盖 message（比如带上剩余时间），但这里提供兜底，
 *      保证客户端任何时候都能拿到可读文案，不会出现「未知错误」。
 */
export const ErrorMessage: Record<number, string> = {
  [ErrorCode.INTERNAL_ERROR]: '服务器开小差了，请稍后重试',
  [ErrorCode.BAD_REQUEST]: '请求参数有误',
  [ErrorCode.UNAUTHORIZED]: '请先登录',
  [ErrorCode.FORBIDDEN]: '没有操作权限',
  [ErrorCode.NOT_FOUND]: '内容不存在',
  [ErrorCode.VALIDATION_FAILED]: '输入内容不合法',
  [ErrorCode.PAYLOAD_TOO_LARGE]: '内容过大',
  [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: '不支持的文件类型',
  [ErrorCode.CONFLICT]: '数据冲突，请刷新后重试',
  [ErrorCode.CLOCK_SKEW]: '设备时间不准确，请校准后重试',

  [ErrorCode.EMAIL_INVALID]: '邮箱格式不正确',
  [ErrorCode.EMAIL_ALREADY_REGISTERED]: '该邮箱已注册，请直接登录',
  [ErrorCode.EMAIL_CODE_INVALID]: '验证码不正确',
  [ErrorCode.EMAIL_CODE_EXPIRED]: '验证码已过期，请重新获取',
  [ErrorCode.EMAIL_CODE_TOO_MANY_ATTEMPTS]: '验证码错误次数过多，请重新获取',
  [ErrorCode.EMAIL_SEND_FAILED]: '验证码发送失败，请稍后重试',
  [ErrorCode.PASSWORD_WEAK]: '密码强度不足',
  [ErrorCode.CREDENTIALS_INVALID]: '邮箱或密码不正确',
  [ErrorCode.ACCOUNT_DISABLED]: '账号已被停用',
  [ErrorCode.TOKEN_INVALID]: '登录状态无效，请重新登录',
  [ErrorCode.TOKEN_EXPIRED]: '登录已过期，请重新登录',
  [ErrorCode.REFRESH_TOKEN_REVOKED]: '登录状态已失效，请重新登录',
  [ErrorCode.INVITE_REQUIRED]: '注册需要邀请码',

  [ErrorCode.INVITE_CODE_NOT_FOUND]: '邀请码不存在',
  [ErrorCode.INVITE_CODE_EXHAUSTED]: '邀请码使用次数已用完',
  [ErrorCode.INVITE_CODE_EXPIRED]: '邀请码已过期',
  [ErrorCode.INVITE_QUOTA_EXCEEDED]: '可邀请名额不足',

  [ErrorCode.CONVERSATION_NOT_FOUND]: '会话不存在',
  [ErrorCode.NOT_A_MEMBER]: '你不在该会话中',
  [ErrorCode.CANNOT_CHAT_WITH_SELF]: '不能和自己聊天',
  [ErrorCode.GROUP_MEMBER_LIMIT]: '群成员已达上限',
  [ErrorCode.NOT_GROUP_OWNER]: '只有群主可以执行该操作',
  [ErrorCode.MEMBER_NOT_FOUND]: '成员不存在',

  [ErrorCode.MESSAGE_NOT_FOUND]: '消息不存在',
  [ErrorCode.MESSAGE_TOO_LONG]: '消息内容过长',
  [ErrorCode.MESSAGE_EMPTY]: '消息内容不能为空',
  [ErrorCode.MESSAGE_DELETE_FORBIDDEN]: '只能删除自己发送的消息',
  [ErrorCode.REPLY_TARGET_INVALID]: '引用的消息不存在',
  [ErrorCode.REACTION_TARGET_INVALID]: '回应的消息不存在',

  [ErrorCode.FRIEND_SELF]: '不能添加自己为好友',
  [ErrorCode.FRIEND_ALREADY]: '你们已经是好友了',
  [ErrorCode.FRIEND_REQUEST_PENDING_INCOMING]: '对方已向你发送好友请求，请去「新的朋友」处理',
  [ErrorCode.FRIEND_REQUEST_PENDING_OUTGOING]: '好友请求已发送，请等待对方确认',
  [ErrorCode.FRIEND_REQUEST_NOT_FOUND]: '好友请求不存在或已处理',
  [ErrorCode.FRIEND_NOT_FOUND]: '你们还不是好友',
  [ErrorCode.FRIEND_BLOCKED_BY_PEER]: '无法完成操作',
  [ErrorCode.FRIEND_BLOCKED_BY_SELF]: '你已拉黑对方，请先解除拉黑',

  [ErrorCode.GROUP_PERMISSION_DENIED]: '权限不足，仅群主或管理员可操作',
  [ErrorCode.GROUP_OWNER_CANNOT_LEAVE]: '群主不能直接退群，请先转让群主',
  [ErrorCode.GROUP_MEMBER_EXISTS]: '对方已在群里',
  [ErrorCode.GROUP_MEMBER_LIMIT_REACHED]: '群成员已达上限',
  [ErrorCode.GROUP_OPERATION_ON_SELF]: '不能对自己执行该操作',

  [ErrorCode.FILE_TOO_LARGE]: '文件超过大小限制',
  [ErrorCode.FILE_TYPE_NOT_ALLOWED]: '不支持该文件类型',
  [ErrorCode.ATTACHMENT_NOT_FOUND]: '附件不存在',
  [ErrorCode.ATTACHMENT_ALREADY_BOUND]: '附件已被使用',
  [ErrorCode.UPLOAD_INCOMPLETE]: '文件上传不完整',
  [ErrorCode.ATTACHMENT_EXPIRED]: '文件已过期（聊天文件仅保留 30 天）',

  [ErrorCode.CALL_NOT_FOUND]: '通话不存在',
  [ErrorCode.CALL_ALREADY_ENDED]: '通话已结束',
  [ErrorCode.CALL_PARTICIPANT_LIMIT]: '通话人数已达上限',
  [ErrorCode.CALL_STATE_INVALID]: '通话状态异常',

  [ErrorCode.RATE_LIMITED]: '操作太频繁，请稍后再试',
  [ErrorCode.TOO_MANY_REQUESTS]: '请求过于频繁，请稍后再试',
};

/**
 * 错误码 → HTTP 状态码映射
 * 说明：精确列出，不用区间判断。区间判断容易把「邮箱格式错」误判成 401，
 *      导致客户端误触发「跳登录页」逻辑（历史项目踩过的坑）。
 */
const HTTP_STATUS_MAP: Record<number, number> = {
  [ErrorCode.OK]: 200,

  /* 通用 */
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.VALIDATION_FAILED]: 400,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: 415,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.CLOCK_SKEW]: 400,

  /* 认证 */
  [ErrorCode.EMAIL_INVALID]: 400,
  [ErrorCode.EMAIL_ALREADY_REGISTERED]: 409,
  [ErrorCode.EMAIL_CODE_INVALID]: 400,
  [ErrorCode.EMAIL_CODE_EXPIRED]: 400,
  [ErrorCode.EMAIL_CODE_TOO_MANY_ATTEMPTS]: 400,
  [ErrorCode.EMAIL_SEND_FAILED]: 502,
  [ErrorCode.PASSWORD_WEAK]: 400,
  [ErrorCode.CREDENTIALS_INVALID]: 401,
  [ErrorCode.ACCOUNT_DISABLED]: 403,
  [ErrorCode.TOKEN_INVALID]: 401,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.REFRESH_TOKEN_REVOKED]: 401,
  [ErrorCode.INVITE_REQUIRED]: 400,

  /* 邀请 */
  [ErrorCode.INVITE_CODE_NOT_FOUND]: 400,
  [ErrorCode.INVITE_CODE_EXHAUSTED]: 400,
  [ErrorCode.INVITE_CODE_EXPIRED]: 400,
  [ErrorCode.INVITE_QUOTA_EXCEEDED]: 403,

  /* 会话 */
  [ErrorCode.CONVERSATION_NOT_FOUND]: 404,
  [ErrorCode.NOT_A_MEMBER]: 403,
  [ErrorCode.CANNOT_CHAT_WITH_SELF]: 400,
  [ErrorCode.GROUP_MEMBER_LIMIT]: 409,
  [ErrorCode.NOT_GROUP_OWNER]: 403,
  [ErrorCode.MEMBER_NOT_FOUND]: 404,

  /* 消息 */
  [ErrorCode.MESSAGE_NOT_FOUND]: 404,
  [ErrorCode.MESSAGE_TOO_LONG]: 400,
  [ErrorCode.MESSAGE_EMPTY]: 400,
  [ErrorCode.MESSAGE_DELETE_FORBIDDEN]: 403,
  [ErrorCode.REPLY_TARGET_INVALID]: 400,
  [ErrorCode.REACTION_TARGET_INVALID]: 404,

  [ErrorCode.FRIEND_SELF]: 400,
  [ErrorCode.FRIEND_ALREADY]: 409,
  [ErrorCode.FRIEND_REQUEST_PENDING_INCOMING]: 409,
  [ErrorCode.FRIEND_REQUEST_PENDING_OUTGOING]: 409,
  [ErrorCode.FRIEND_REQUEST_NOT_FOUND]: 404,
  [ErrorCode.FRIEND_NOT_FOUND]: 404,
  [ErrorCode.FRIEND_BLOCKED_BY_PEER]: 403,
  [ErrorCode.FRIEND_BLOCKED_BY_SELF]: 403,

  [ErrorCode.GROUP_PERMISSION_DENIED]: 403,
  [ErrorCode.GROUP_OWNER_CANNOT_LEAVE]: 400,
  [ErrorCode.GROUP_MEMBER_EXISTS]: 409,
  [ErrorCode.GROUP_MEMBER_LIMIT_REACHED]: 400,
  [ErrorCode.GROUP_OPERATION_ON_SELF]: 400,

  /* 上传 */
  [ErrorCode.FILE_TOO_LARGE]: 413,
  [ErrorCode.FILE_TYPE_NOT_ALLOWED]: 415,
  [ErrorCode.ATTACHMENT_NOT_FOUND]: 404,
  [ErrorCode.ATTACHMENT_ALREADY_BOUND]: 409,
  [ErrorCode.UPLOAD_INCOMPLETE]: 400,
  [ErrorCode.ATTACHMENT_EXPIRED]: 410,

  /* 通话 */
  [ErrorCode.CALL_NOT_FOUND]: 404,
  [ErrorCode.CALL_ALREADY_ENDED]: 409,
  [ErrorCode.CALL_PARTICIPANT_LIMIT]: 409,
  [ErrorCode.CALL_STATE_INVALID]: 409,

  /* 限流 */
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.TOO_MANY_REQUESTS]: 429,
};

/** 查询 HTTP 状态码，未登记的按 400 处理（业务错通常都是客户端问题） */
export function httpStatusFor(code: number): number {
  return HTTP_STATUS_MAP[code] ?? 400;
}
