/**
 * ============================================================
 * ICE 配置（STUN + TURN 临时凭据）
 * ------------------------------------------------------------
 * 这是「P2P 打不通怎么办」的核心实现。
 *
 * ICE 三层候选与降级顺序：
 *   1. host   —— 本机网卡地址，同局域网直连，延迟最低
 *   2. srflx  —— 通过 STUN 探测到的公网映射地址，锥形 NAT 下可打洞
 *   3. relay  —— 通过 TURN 分配的服务器中继地址，任何 NAT 都能通
 * 浏览器/客户端会自动收集并测试所有候选，选最优的一条。
 * 我们的责任只是「把 STUN 与 TURN 地址正确下发给客户端」。
 *
 * 为什么用临时凭据（TURN REST API）：
 * - 静态账号密码必须写进客户端，等于公开，任何人都能白嫖服务器带宽；
 * - 临时凭据格式：username = "<过期时间戳>:<用户id>"
 *                  credential = base64(HMAC-SHA1(密钥, username))
 * - coturn 用同一密钥独立验算，服务端不需要存储任何会话状态；
 * - 凭据到期自动失效，泄露风险可控。
 * ============================================================
 */

import type { IceConfigResponse, IceServerConfig } from '@chat/shared';
import { createHmac } from 'node:crypto';
import { config } from '../../config.js';
import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('ice');

/**
 * 签发 TURN 临时凭据
 * @param userId 用户 id，写进 username 便于在 coturn 日志里追溯用量
 * @returns username / credential；未配置密钥时返回 null（降级为纯 STUN）
 */
export function issueTurnCredential(userId: string): { username: string; credential: string } | null {
  const secret = config.turn.staticAuthSecret;
  if (!secret) return null;

  // 过期时间戳（秒）：coturn 用这个时间判断凭据是否有效
  const expiry = Math.floor(Date.now() / 1000) + config.turn.credentialTtlSeconds;
  const username = `${expiry}:${userId}`;

  // TURN REST API 规范：HMAC-SHA1 + Base64
  const credential = createHmac('sha1', secret).update(username).digest('base64');

  return { username, credential };
}

/**
 * 构造下发给客户端的 ICE 服务器列表
 * 注意顺序：
 *   1. 先 STUN（不产生服务器带宽成本，能直连就直连）
 *   2. 再 TURN（只有打洞失败才会用到）
 */
export function buildIceServers(userId: string): IceConfigResponse {
  const servers: IceServerConfig[] = [];

  // ---------- STUN：只用于探测公网地址，不转发媒体 ----------
  if (config.turn.stunUrls.length > 0) {
    servers.push({ urls: config.turn.stunUrls });
  }

  // ---------- TURN：媒体中继兜底 ----------
  const credential = issueTurnCredential(userId);
  if (credential && config.turn.urls.length > 0) {
    servers.push({
      urls: config.turn.urls,
      username: credential.username,
      credential: credential.credential,
    });
  } else if (config.turn.urls.length > 0) {
    log.warn({ userId }, 'TURN_STATIC_AUTH_SECRET 未配置，本次只下发 STUN');
  }

  return {
    iceServers: servers,
    maxParticipants: config.call.meshMaxParticipants,
    // 首版语音走 P2P，不启用 SFU
    sfuEnabled: config.sfu.enabled,
    // 首版只支持语音，视频后续开放
    supportedModes: config.call.videoEnabled ? ['audio', 'video'] : ['audio'],
  };
}

/**
 * 判断一次通话是否需要服务器中转
 * 用途：通话结束后统计「中继占比」，用于容量规划与成本估算。
 * @param selectedCandidateType ICE 协商完成后选中的候选类型
 */
export function isRelayed(selectedCandidateType: string | null | undefined): boolean {
  return selectedCandidateType === 'relay';
}
