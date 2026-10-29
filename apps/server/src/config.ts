/**
 * ============================================================
 * 服务端配置
 * ------------------------------------------------------------
 * 设计原则：
 * 1. 所有配置来自环境变量，代码里不写任何密钥；
 * 2. 启动时一次性校验，缺关键项直接退出（避免运行到一半才报错）；
 * 3. 生产环境强制要求 JWT_SECRET / 数据库密码等，开发环境允许默认值。
 * ============================================================
 */

import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// 加载 .env：优先读项目根目录，其次读 server 目录（本地开发两种位置都兼容）
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), '../../.env') });

const isProd = process.env.NODE_ENV === 'production';

/** 读取必填环境变量；缺失时抛错并给出明确提示 */
function required(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === '') {
    throw new Error(`缺少必需的环境变量 ${key}，请在 .env 中配置`);
  }
  return v.trim();
}

/** 读取可选环境变量 */
function optional(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

export const config = {
  env: isProd ? 'production' : 'development',
  isProd,

  /** HTTP 服务端口：仅监听回环，由 OpenResty 反代 */
  host: optional('HOST', '127.0.0.1'),
  port: num('PORT', 8787),

  /** 对外域名，用于拼接媒体签名 URL */
  publicOrigin: optional('PUBLIC_ORIGIN', 'https://chat.lkz.pub'),

  /** 数据库 */
  db: {
    host: optional('DB_HOST', '127.0.0.1'),
    port: num('DB_PORT', 3306),
    user: optional('DB_USER', 'chat2'),
    password: isProd ? required('DB_PASSWORD') : optional('DB_PASSWORD', ''),
    database: optional('DB_NAME', 'chat2'),
    connectionLimit: num('DB_POOL_SIZE', 10),
  },

  /** JWT：access 用 HS256 对称签名，refresh 存哈希在库里 */
  jwt: {
    secret: isProd ? required('JWT_SECRET') : optional('JWT_SECRET', 'dev-only-secret-change-me-32chars-min'),
    issuer: optional('JWT_ISSUER', 'chat.lkz.pub'),
  },

  /** 邮件：验证码发送 */
  smtp: {
    host: optional('SMTP_HOST', 'smtp.zoho.com'),
    port: num('SMTP_PORT', 587),
    /** true 使用 465 隐式 TLS，false 使用 587 STARTTLS */
    secure: bool('SMTP_SECURE', false),
    user: optional('SMTP_USER', ''),
    pass: optional('SMTP_PASS', ''),
    fromName: optional('SMTP_FROM_NAME', 'chat'),
    fromAddress: optional('SMTP_FROM', ''),
    /**
     * 验证码日志兜底开关。
     * 默认值：开发环境开、生产环境关。
     * 允许通过环境变量强制开启（用于「SMTP 尚未配置好但需要先跑通注册流程」的场景），
     * 但会在启动时打印高危告警，提醒尽快关闭。
     */
    devFallback: bool('SMTP_DEV_FALLBACK', !isProd),
  },

  /** 上传目录与限制 */
  upload: {
    dir: optional('UPLOAD_DIR', resolve(process.cwd(), '../../runtime/uploads')),
    maxBytes: num('UPLOAD_MAX_BYTES', 200 * 1024 * 1024),
    /** 媒体签名 URL 有效期（秒） */
    urlTtlSeconds: num('MEDIA_URL_TTL', 3600),
  },

  /**
   * TURN：复用服务器已部署的 coturn
   * 说明：使用「临时凭据」而不是固定账号密码。
   *      服务端用 staticAuthSecret 为每个用户签发带过期时间的凭据，
   *      客户端泄露凭据也只能用 24 小时，且无法被用来刷他人流量。
   */
  turn: {
    /**
     * 客户端使用的 TURN 地址列表。
     * 顺序很重要：ICE 会按顺序尝试，UDP 优先（延迟最低），
     * TCP/TLS 作为受限网络（企业防火墙只放行 443/5349）的兜底。
     */
    urls: optional(
      'TURN_URLS',
      [
        'turn:chat.lkz.pub:3478?transport=udp',
        'turn:chat.lkz.pub:3478?transport=tcp',
        'turns:chat.lkz.pub:5349?transport=tcp',
      ].join(','),
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** 与 /etc/turnserver.conf 的 static-auth-secret 保持一致 */
    staticAuthSecret: optional('TURN_STATIC_AUTH_SECRET', ''),
    /** 临时凭据有效期（秒）：24 小时，够一次通话周期 */
    credentialTtlSeconds: num('TURN_CREDENTIAL_TTL', 86400),
    /** STUN 服务器：用于发现公网映射地址（srflx 候选） */
    stunUrls: optional('STUN_URLS', 'stun:chat.lkz.pub:3478')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  /** mediasoup SFU（首版不启用，视频阶段再开） */
  sfu: {
    /** 是否启用 SFU；false 时语音走 P2P Mesh，服务器零媒体转发 */
    enabled: bool('SFU_ENABLED', false),
    /** 本机内网 IP，mediasoup 绑定用 */
    listenIp: optional('SFU_LISTEN_IP', '0.0.0.0'),
    /** 对外通告 IP（NAT 后的公网 IP），必须正确否则媒体不通 */
    announcedIp: optional('SFU_ANNOUNCED_IP', ''),
    /** RTC 端口范围，需在安全组放行 UDP */
    rtcMinPort: num('SFU_RTC_MIN_PORT', 40000),
    rtcMaxPort: num('SFU_RTC_MAX_PORT', 40100),
    /** 单房间最大人数 */
    maxParticipants: num('SFU_MAX_PARTICIPANTS', 16),
  },

  /** 通话 */
  call: {
    /**
     * 来电振铃超时（毫秒）
     * 45 秒：比手机系统来电铃声短，避免对方挂断后还在响。
     */
    ringTimeoutMs: num('CALL_RING_TIMEOUT_MS', 45_000),
    /**
     * P2P Mesh 最大人数
     * 8 人时每端维持 7 条 PeerConnection，语音上行约 280kbps。
     */
    meshMaxParticipants: num('CALL_MESH_MAX', 8),
    /** 是否允许视频通话（首版关闭，只做语音） */
    videoEnabled: bool('CALL_VIDEO_ENABLED', false),
  },

  /** 推送：各厂商 HTTP API 凭据，未配置的通道自动跳过 */
  push: {
    apns: {
      keyId: optional('APNS_KEY_ID', ''),
      teamId: optional('APNS_TEAM_ID', ''),
      /** .p8 私钥内容（换行用 \n 转义或直接多行） */
      privateKey: optional('APNS_PRIVATE_KEY', '').replace(/\\n/g, '\n'),
      topic: optional('APNS_TOPIC', 'pub.lkz.chat'),
      /** 开发用 sandbox，正式用 production */
      production: bool('APNS_PRODUCTION', true),
    },
    hms: {
      appId: optional('HMS_APP_ID', ''),
      appSecret: optional('HMS_APP_SECRET', ''),
    },
    xiaomi: {
      appSecret: optional('XIAOMI_APP_SECRET', ''),
      packageName: optional('XIAOMI_PACKAGE', 'pub.lkz.chat'),
    },
    oppo: {
      appKey: optional('OPPO_APP_KEY', ''),
      masterSecret: optional('OPPO_MASTER_SECRET', ''),
    },
    vivo: {
      appId: optional('VIVO_APP_ID', ''),
      appKey: optional('VIVO_APP_KEY', ''),
      appSecret: optional('VIVO_APP_SECRET', ''),
    },
    harmony: {
      appId: optional('HARMONY_PUSH_APP_ID', ''),
      appSecret: optional('HARMONY_PUSH_APP_SECRET', ''),
    },
  },

  /** 日志 */
  log: {
    level: optional('LOG_LEVEL', isProd ? 'info' : 'debug'),
    pretty: !isProd && bool('LOG_PRETTY', true),
  },

  /** 注册开关：关闭后只有持邀请码的老用户能邀请新人 */
  registration: {
    /** 注册是否必须邀请码 */
    requireInvite: bool('REGISTER_REQUIRE_INVITE', true),
    /** 新用户初始邀请名额 */
    defaultInviteQuota: num('DEFAULT_INVITE_QUOTA', 5),
  },
} as const;

/** 启动前自检：把容易配错的项提前暴露出来 */
export function validateConfig(): string[] {
  const warnings: string[] = [];

  if (!config.turn.staticAuthSecret) {
    warnings.push('TURN_STATIC_AUTH_SECRET 未配置：约 20% 的网络环境将无法建立语音通话');
  }
  if (config.call.videoEnabled && !config.sfu.enabled) {
    warnings.push('CALL_VIDEO_ENABLED 已开启但 SFU_ENABLED 未开启：多人视频不可用');
  }
  if (!config.smtp.user || !config.smtp.pass) {
    warnings.push('SMTP 未配置：邮箱验证码将只输出到日志（仅开发可用）');
  }
  if (!config.push.apns.privateKey) {
    warnings.push('APNS 未配置：iOS 离线推送不可用');
  }
  if (!config.push.hms.appId) {
    warnings.push('HMS 未配置：华为设备离线推送不可用');
  }
  if (config.jwt.secret.includes('dev-only')) {
    warnings.push('JWT_SECRET 使用开发默认值，请在生产环境更换');
  }
  if (config.isProd && config.smtp.devFallback) {
    warnings.push(
      '【高危】生产环境已开启 SMTP_DEV_FALLBACK：验证码会写入日志，仅用于 SMTP 未就绪的过渡期，配置完成后请立即设为 false',
    );
  }
  return warnings;
}
