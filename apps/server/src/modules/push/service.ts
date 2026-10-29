/**
 * ============================================================
 * 离线推送服务（国内厂商通道 + APNs）
 * ------------------------------------------------------------
 * 为什么必须做厂商通道：
 * 国内 Android 没有 GMS，FCM 不可用；App 被系统杀掉后，
 * 只有厂商推送通道能唤醒进程弹出「来电」界面。
 *
 * 支持的通道：
 *   - APNs     iOS（HTTP/2 + JWT ES256，无需第三方库）
 *   - HMS      华为/荣耀
 *   - 小米     MIUI
 *   - OPPO     ColorOS
 *   - vivo     OriginOS
 *   - Harmony  HarmonyOS NEXT 自有通道
 *
 * 设计原则：
 * 1. 未配置凭据的通道自动跳过，不抛错（便于分阶段接入）；
 * 2. 推送失败只记日志，绝不影响主流程（通话信令已经通过 WS 发出）；
 * 3. 单次推送并发发往用户所有设备的所有通道，任一成功即可。
 * ============================================================
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pushTokens } from '../../db/schema.js';
import { config } from '../../config.js';
import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('push');

/* ------------------------------------------------------------------ */
/* 推送内容                                                             */
/* ------------------------------------------------------------------ */

export interface PushPayload {
  title: string;
  body: string;
  /** 来电 id：客户端点击通知后据此进入通话界面 */
  callId?: string;
  /** 会话 id：普通消息推送时用于跳转到聊天页 */
  conversationId?: string;
  /** 未读数，用于角标 */
  badge?: number;
}

/* ------------------------------------------------------------------ */
/* APNs（iOS）                                                          */
/* ------------------------------------------------------------------ */

/**
 * APNs 使用 HTTP/2 + JWT（ES256）鉴权。
 * 为什么不用 node-apn：那是个已停止维护的库，且会引入额外依赖；
 * 直接用 Node 22 内置的 http2 + jose 签名即可，零额外包。
 */
let apnsJwtCache: { token: string; expiresAt: number } | null = null;

async function getApnsJwt(): Promise<string | null> {
  const { keyId, teamId, privateKey } = config.push.apns;
  if (!keyId || !teamId || !privateKey) return null;

  // JWT 有效期 50 分钟（Apple 要求 20-60 分钟刷新一次）
  if (apnsJwtCache && apnsJwtCache.expiresAt > Date.now()) {
    return apnsJwtCache.token;
  }

  try {
    const { SignJWT, importPKCS8 } = await import('jose');
    const key = await importPKCS8(privateKey, 'ES256');
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: keyId })
      .setIssuer(teamId)
      .setIssuedAt()
      .sign(key);

    apnsJwtCache = { token, expiresAt: Date.now() + 50 * 60 * 1000 };
    return token;
  } catch (e) {
    log.error({ err: e }, 'APNs JWT 生成失败，请检查 .p8 私钥格式');
    return null;
  }
}

async function sendApns(deviceToken: string, payload: PushPayload): Promise<boolean> {
  const jwt = await getApnsJwt();
  if (!jwt) return false;

  const host = config.push.apns.production
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';

  const body = JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
      // 来电必须用 critical 类声音，否则静音模式下不响
      ...(payload.callId ? { 'interruption-level': 'time-sensitive' } : {}),
      ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
      // 用于客户端区分「来电」与「普通消息」
      'mutable-content': 1,
    },
    callId: payload.callId,
    conversationId: payload.conversationId,
  });

  try {
    const { connect } = await import('node:http2');
    const client = connect(host);

    return await new Promise<boolean>((resolve) => {
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': config.push.apns.topic,
        'apns-push-type': payload.callId ? 'voip' : 'alert',
        'apns-priority': payload.callId ? '10' : '5',
        'content-type': 'application/json',
      });

      let status = 0;
      req.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      req.on('error', () => {
        client.close();
        resolve(false);
      });
      req.on('end', () => {
        client.close();
        resolve(status === 200);
      });
      req.end(body);
    });
  } catch (e) {
    log.warn({ err: e }, 'APNs 推送失败');
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 华为 HMS                                                             */
/* ------------------------------------------------------------------ */

let hmsTokenCache: { token: string; expiresAt: number } | null = null;

async function getHmsToken(): Promise<string | null> {
  const { appId, appSecret } = config.push.hms;
  if (!appId || !appSecret) return null;
  if (hmsTokenCache && hmsTokenCache.expiresAt > Date.now()) return hmsTokenCache.token;

  try {
    const res = await fetch('https://oauth-login.cloud.huawei.com/oauth2/v3/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appId,
        client_secret: appSecret,
      }),
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;
    hmsTokenCache = {
      token: json.access_token,
      expiresAt: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000,
    };
    return hmsTokenCache.token;
  } catch (e) {
    log.warn({ err: e }, 'HMS token 获取失败');
    return null;
  }
}

async function sendHms(deviceToken: string, payload: PushPayload): Promise<boolean> {
  const token = await getHmsToken();
  if (!token) return false;

  try {
    const res = await fetch(
      `https://push-api.cloud.huawei.com/v1/${config.push.hms.appId}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: [deviceToken],
            notification: { title: payload.title, body: payload.body },
            android: {
              // HIGH 优先级才能在 App 被杀后唤醒
              urgency: payload.callId ? 'HIGH' : 'NORMAL',
              category: payload.callId ? 'CALL' : 'MESSAGE',
              data: JSON.stringify({ callId: payload.callId, conversationId: payload.conversationId }),
            },
          },
        }),
      },
    );
    return res.ok;
  } catch (e) {
    log.warn({ err: e }, 'HMS 推送失败');
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 小米                                                                 */
/* ------------------------------------------------------------------ */

async function sendXiaomi(deviceToken: string, payload: PushPayload): Promise<boolean> {
  const { appSecret, packageName } = config.push.xiaomi;
  if (!appSecret) return false;

  try {
    const params = new URLSearchParams({
      registration_id: deviceToken,
      title: payload.title,
      description: payload.body,
      // 1 = 使用「通知消息」通道，系统级展示
      notify_type: '-1',
      // 2 = 高优先级（来电必须）
      pass_through: payload.callId ? '0' : '0',
      extra: JSON.stringify({ callId: payload.callId, conversationId: payload.conversationId }),
    });

    const res = await fetch('https://api.xmpush.xiaomi.com/v3/message/regid', {
      method: 'POST',
      headers: {
        Authorization: `key=${appSecret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const json = (await res.json()) as { code?: number };
    if (json.code !== 0) {
      log.warn({ code: json.code, packageName }, '小米推送返回异常');
      return false;
    }
    return true;
  } catch (e) {
    log.warn({ err: e }, '小米推送失败');
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* OPPO / vivo                                                          */
/* ------------------------------------------------------------------ */

let oppoTokenCache: { token: string; expiresAt: number } | null = null;

async function getOppoToken(): Promise<string | null> {
  const { appKey, masterSecret } = config.push.oppo;
  if (!appKey || !masterSecret) return null;
  if (oppoTokenCache && oppoTokenCache.expiresAt > Date.now()) return oppoTokenCache.token;

  try {
    const res = await fetch('https://api.oppo.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appKey,
        client_secret: masterSecret,
      }),
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;
    oppoTokenCache = {
      token: json.access_token,
      expiresAt: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000,
    };
    return oppoTokenCache.token;
  } catch {
    return null;
  }
}

async function sendOppo(deviceToken: string, payload: PushPayload): Promise<boolean> {
  const token = await getOppoToken();
  if (!token) return false;

  try {
    const res = await fetch('https://api.oppo.com/server/v1/message/notification/unicast', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        auth_token: token,
        message: {
          target_type: 2,
          target_value: deviceToken,
          notification: {
            title: payload.title,
            sub_title: payload.body,
            click_action_type: 1,
            // 1 = 优先生效，来电需要立即展示
            show_time_type: 1,
            off_line: true,
            off_line_ttl: 3600,
          },
        },
      }),
    });
    return res.ok;
  } catch (e) {
    log.warn({ err: e }, 'OPPO 推送失败');
    return false;
  }
}

let vivoTokenCache: { token: string; expiresAt: number } | null = null;

async function getVivoToken(): Promise<string | null> {
  const { appId, appKey, appSecret } = config.push.vivo;
  if (!appId || !appKey || !appSecret) return null;
  if (vivoTokenCache && vivoTokenCache.expiresAt > Date.now()) return vivoTokenCache.token;

  try {
    const res = await fetch('https://api-push.vivo.com.cn/message/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, appKey, appSecret }),
    });
    const json = (await res.json()) as { authToken?: string; result?: number };
    if (json.result !== 0 || !json.authToken) return null;
    // vivo token 有效期 24 小时，提前 1 小时刷新
    vivoTokenCache = { token: json.authToken, expiresAt: Date.now() + 23 * 60 * 60 * 1000 };
    return vivoTokenCache.token;
  } catch {
    return null;
  }
}

async function sendVivo(deviceToken: string, payload: PushPayload): Promise<boolean> {
  const token = await getVivoToken();
  if (!token) return false;

  try {
    const res = await fetch('https://api-push.vivo.com.cn/message/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authToken: token,
      },
      body: JSON.stringify({
        regId: deviceToken,
        notifyType: 1,
        title: payload.title,
        content: payload.body,
        timeToLive: 3600,
        // 高优先级，保证来电及时到达
        priority: 1,
        skipType: 1,
        skipContent: JSON.stringify({ callId: payload.callId, conversationId: payload.conversationId }),
      }),
    });
    const json = (await res.json()) as { result?: number };
    return json.result === 0;
  } catch (e) {
    log.warn({ err: e }, 'vivo 推送失败');
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* HarmonyOS NEXT                                                       */
/* ------------------------------------------------------------------ */

let harmonyTokenCache: { token: string; expiresAt: number } | null = null;

async function getHarmonyToken(): Promise<string | null> {
  const { appId, appSecret } = config.push.harmony;
  if (!appId || !appSecret) return null;
  if (harmonyTokenCache && harmonyTokenCache.expiresAt > Date.now()) return harmonyTokenCache.token;

  try {
    const res = await fetch('https://oauth-login.cloud.huawei.com/oauth2/v3/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appId,
        client_secret: appSecret,
      }),
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;
    harmonyTokenCache = {
      token: json.access_token,
      expiresAt: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000,
    };
    return harmonyTokenCache.token;
  } catch {
    return null;
  }
}

async function sendHarmony(deviceToken: string, payload: PushPayload): Promise<boolean> {
  const token = await getHarmonyToken();
  if (!token) return false;

  try {
    const res = await fetch(
      `https://push-api.cloud.huawei.com/v1/${config.push.harmony.appId}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: [deviceToken],
            notification: { title: payload.title, body: payload.body },
            data: JSON.stringify({ callId: payload.callId, conversationId: payload.conversationId }),
          },
        }),
      },
    );
    return res.ok;
  } catch (e) {
    log.warn({ err: e }, 'Harmony 推送失败');
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                             */
/* ------------------------------------------------------------------ */

/** 按厂商标识分发到对应实现 */
async function sendByProvider(
  provider: string,
  deviceToken: string,
  payload: PushPayload,
): Promise<boolean> {
  switch (provider) {
    case 'apns':
      return sendApns(deviceToken, payload);
    case 'hms':
      return sendHms(deviceToken, payload);
    case 'xiaomi':
      return sendXiaomi(deviceToken, payload);
    case 'oppo':
      return sendOppo(deviceToken, payload);
    case 'vivo':
      return sendVivo(deviceToken, payload);
    case 'harmony':
      return sendHarmony(deviceToken, payload);
    default:
      return false;
  }
}

/**
 * 给离线用户推送
 * 说明：用户可能有多台设备、每个设备可能注册过多个通道，
 *      全部并发推送，任一成功即认为送达。
 */
export async function pushToOfflineUsers(userIds: string[], payload: PushPayload): Promise<void> {
  if (userIds.length === 0) return;

  const rows = await db
    .select({
      userId: pushTokens.userId,
      provider: pushTokens.provider,
      token: pushTokens.token,
    })
    .from(pushTokens)
    .where(eq(pushTokens.userId, userIds[0]!));

  // 多用户时逐个查（用户量小，避免复杂的 IN 查询拼接）
  const allTokens = [...rows];
  for (const uid of userIds.slice(1)) {
    const more = await db
      .select({
        userId: pushTokens.userId,
        provider: pushTokens.provider,
        token: pushTokens.token,
      })
      .from(pushTokens)
      .where(eq(pushTokens.userId, uid));
    allTokens.push(...more);
  }

  if (allTokens.length === 0) {
    log.debug({ userIds: userIds.length }, '离线用户没有注册推送令牌');
    return;
  }

  const results = await Promise.allSettled(
    allTokens.map((t) => sendByProvider(t.provider, t.token, payload)),
  );

  const ok = results.filter((r) => r.status === 'fulfilled' && r.value).length;
  log.info({ total: allTokens.length, ok, users: userIds.length }, '离线推送完成');
}

/** 注册/更新推送令牌（同设备重复注册会覆盖） */
export async function upsertPushToken(params: {
  userId: string;
  platform: string;
  provider: string;
  deviceId: string;
  token: string;
  appVersion?: string;
}): Promise<void> {
  const now = Date.now();
  const { and } = await import('drizzle-orm');

  // 先删同设备同通道的旧令牌，避免 token 轮换后残留
  await db
    .delete(pushTokens)
    .where(and(eq(pushTokens.userId, params.userId), eq(pushTokens.deviceId, params.deviceId)));

  const { newId } = await import('../../lib/ids.js');

  await db.insert(pushTokens).values({
    id: newId(),
    userId: params.userId,
    platform: params.platform,
    provider: params.provider,
    deviceId: params.deviceId,
    token: params.token,
    appVersion: params.appVersion ?? null,
    updatedAt: now,
  });
}

/** 注销推送令牌（用户退出登录或关闭推送时调用） */
export async function removePushToken(userId: string, deviceId: string): Promise<void> {
  const { and } = await import('drizzle-orm');
  await db
    .delete(pushTokens)
    .where(and(eq(pushTokens.userId, userId), eq(pushTokens.deviceId, deviceId)));
}
