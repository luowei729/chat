/**
 * ============================================================
 * 邮件发送（邮箱验证码）
 * ------------------------------------------------------------
 * 为什么用 nodemailer + SMTP 而不是第三方 API：
 * 1. 用户已有 Zoho 企业邮，零额外成本；
 * 2. SMTP 通用，换服务商只改环境变量；
 * 3. 云服务器 25 端口被封，必须用 587(STARTTLS) 或 465(SSL)。
 *
 * 可靠性设计：
 * - 连接复用（pool），避免每次发信都重新 TLS 握手；
 * - 发送失败时：开发环境把验证码打到日志兜底，生产环境抛错；
 * - 所有邮件正文使用内联样式，兼容 QQ 邮箱/网易/Outlook。
 * ============================================================
 */

import { EMAIL_CODE_TTL_MINUTES } from '@chat/shared';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { moduleLogger } from '../lib/logger.js';

const log = moduleLogger('mail');

let transporter: Transporter | null = null;

/** 懒初始化 SMTP 连接池：未配置时不建立连接，避免启动即失败 */
function getTransporter(): Transporter | null {
  if (!config.smtp.user || !config.smtp.pass) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
    // 连接池：高频发码时复用连接
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    // 云服务器到海外 SMTP 延迟较高，放宽超时
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return transporter;
}

/** 验证码邮件 HTML：深色简洁风格，与 App 视觉一致 */
function renderCodeEmail(code: string, purpose: 'register' | 'reset' | 'rebind'): { subject: string; html: string; text: string } {
  const actionText =
    purpose === 'register' ? '注册账号' : purpose === 'reset' ? '重置密码' : '更换邮箱';

  const subject = `【chat】${code} 是你的${actionText}验证码`;

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,'PingFang SC','Microsoft YaHei',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(20,30,60,.08);">
        <tr><td style="background:linear-gradient(135deg,#4f8cff,#7a5cff);padding:26px 28px;">
          <div style="color:#ffffff;font-size:20px;font-weight:600;letter-spacing:.5px;">chat</div>
        </td></tr>
        <tr><td style="padding:32px 28px 8px;">
          <div style="color:#1a2233;font-size:17px;font-weight:600;margin-bottom:10px;">你正在${actionText}</div>
          <div style="color:#6b7688;font-size:14px;line-height:1.7;">
            请在 App 中输入下面的验证码完成验证，${EMAIL_CODE_TTL_MINUTES} 分钟内有效。
          </div>
        </td></tr>
        <tr><td style="padding:22px 28px;">
          <div style="background:#f4f7ff;border:1px solid #dde6ff;border-radius:10px;padding:20px;text-align:center;">
            <span style="font-size:34px;letter-spacing:10px;font-weight:700;color:#2f5fe0;font-family:'SF Mono',Menlo,Consolas,monospace;">${code}</span>
          </div>
        </td></tr>
        <tr><td style="padding:0 28px 28px;">
          <div style="color:#8b95a8;font-size:12px;line-height:1.8;">
            如果这不是你本人的操作，请忽略本邮件，你的账号仍然安全。<br>
            请勿把验证码告诉任何人，官方不会以任何理由向你索取。
          </div>
        </td></tr>
        <tr><td style="background:#fafbfd;padding:16px 28px;border-top:1px solid #eef1f6;">
          <div style="color:#a3abbd;font-size:12px;">本邮件由系统自动发送，请勿直接回复。</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `【chat】${actionText}验证码：${code}，${EMAIL_CODE_TTL_MINUTES} 分钟内有效。请勿泄露给他人。`;

  return { subject, html, text };
}

export interface SendCodeResult {
  /** 是否真正通过 SMTP 发出 */
  delivered: boolean;
  /** 开发环境兜底：把验证码回传给调用方打日志 */
  devCode?: string;
}

/**
 * 发送验证码邮件
 * 注意：函数不会因为 SMTP 失败而抛错（除了生产环境），
 *      避免「邮件服务抖动导致注册接口 500」。
 */
export async function sendVerificationCode(
  to: string,
  code: string,
  purpose: 'register' | 'reset' | 'rebind',
): Promise<SendCodeResult> {
  const tx = getTransporter();
  const { subject, html, text } = renderCodeEmail(code, purpose);

  if (!tx) {
    log.warn({ to, purpose }, 'SMTP 未配置，验证码仅输出到日志');
    if (config.smtp.devFallback) {
      log.info({ to, purpose, code }, '【开发模式】验证码');
      return { delivered: false, devCode: code };
    }
    return { delivered: false };
  }

  try {
    await tx.sendMail({
      from: `"${config.smtp.fromName}" <${config.smtp.fromAddress || config.smtp.user}>`,
      to,
      subject,
      text,
      html,
      // 提升送达率：显式声明为通知类邮件
      headers: {
        'X-Auto-Response-Suppress': 'All',
        'X-Entity-Ref-ID': `chat-${Date.now()}`,
      },
    });
    log.info({ to, purpose }, '验证码邮件已发送');
    return { delivered: true };
  } catch (e) {
    log.error({ err: e, to, purpose }, '验证码邮件发送失败');
    // 开发环境仍然把验证码回传，方便本地联调
    if (config.smtp.devFallback) {
      return { delivered: false, devCode: code };
    }
    throw e;
  }
}

/** 启动时自检 SMTP 连通性（不阻塞启动） */
export async function verifySmtp(): Promise<void> {
  const tx = getTransporter();
  if (!tx) {
    log.warn('SMTP 未配置，跳过连通性检查');
    return;
  }
  try {
    await tx.verify();
    log.info({ host: config.smtp.host, port: config.smtp.port }, 'SMTP 连接验证成功');
  } catch (e) {
    log.error({ err: e }, 'SMTP 连接验证失败，请检查账号密码（Zoho 需使用应用专用密码）');
  }
}
