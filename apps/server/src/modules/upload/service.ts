/**
 * ============================================================
 * 上传服务
 * ------------------------------------------------------------
 * 设计要点：
 * 1. 内容寻址存储：路径由 sha256 决定（前 2 位做目录分片），
 *    相同文件只存一份，聊天里转发同一张图不会重复占磁盘；
 * 2. 流式落盘 + 边写边算哈希：200MB 文件不会把内存打爆
 *    （服务器只有 1.8G 内存，绝不能 readFile 整个文件）；
 * 3. 先写临时文件再原子 rename：避免半截文件被读取；
 * 4. 缩略图与波形由客户端生成后一起上传：服务端不做图片解码，
 *    省 CPU（2 核）与内存，这也是微信/Telegram 的做法；
 * 5. 附件与消息解耦：上传成功先返回 attachmentId，
 *    用户点发送时才绑定，失败重试不会重复上传。
 * ============================================================
 */

import {
  ATTACHMENT_KINDS,
  ATTACHMENT_TTL_MS,
  ErrorCode,
  MAX_UPLOAD_BYTES,
  type AttachmentKind,
  type UploadResult,
} from '@chat/shared';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { MultipartFile } from '@fastify/multipart';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { attachments } from '../../db/schema.js';
import { config } from '../../config.js';
import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/ids.js';
import { moduleLogger } from '../../lib/logger.js';
import { toAttachmentDto } from '../message/service.js';

const log = moduleLogger('upload');

/** 允许的 MIME 前缀/白名单：防止上传可执行文件 */
const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/'];

/** 额外允许的文档类型 */
const ALLOWED_DOC_MIMES = new Set([
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/octet-stream',
]);

/** 判断 MIME 是否允许 */
function isAllowedMime(mime: string): boolean {
  if (ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true;
  return ALLOWED_DOC_MIMES.has(mime);
}

/** 根据 MIME 推断附件类型 */
function inferKind(mime: string): AttachmentKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * 从文件名里取安全扩展名
 * 为什么要过滤：防止 `../../etc/passwd` 之类的路径穿越，
 * 以及 `file.php` 这类可能被 Web 服务器执行的扩展名。
 */
function safeExt(filename: string, mime: string): string {
  const raw = extname(filename).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(raw)) return raw;
  // 没有合法扩展名时按 MIME 兜底
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/webm': '.weba',
  };
  return map[mime] ?? '.bin';
}

/** 内容寻址路径：ab/cd/<sha256><ext>，两级分片避免单目录文件过多 */
function storagePathFor(sha256: string, ext: string): string {
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}${ext}`;
}

/* ------------------------------------------------------------------ */
/* 上传主流程                                                           */
/* ------------------------------------------------------------------ */

export async function saveUpload(params: {
  uploaderId: string;
  file: MultipartFile;
  /** 客户端上报的宽高/时长/波形（可选） */
  meta?: {
    width?: number;
    height?: number;
    durationMs?: number;
    waveform?: number[];
    kind?: string;
  };
}): Promise<UploadResult> {
  const { uploaderId, file, meta } = params;

  const mime = file.mimetype || 'application/octet-stream';
  if (!isAllowedMime(mime)) {
    throw new AppError(ErrorCode.FILE_TYPE_NOT_ALLOWED);
  }

  // 原始文件名可能是 latin1 编码（multipart 的常见坑），转成 utf8
  const originalName = Buffer.from(file.filename, 'latin1').toString('utf8').slice(0, 255);
  const ext = safeExt(originalName, mime);
  const kind = (meta?.kind && ATTACHMENT_KINDS.includes(meta.kind as AttachmentKind))
    ? (meta.kind as AttachmentKind)
    : inferKind(mime);

  await mkdir(config.upload.dir, { recursive: true });

  // 临时文件放在同分区，保证 rename 是原子操作
  const tmpPath = join(config.upload.dir, `.tmp-${newId()}`);
  const hash = createHash('sha256');
  let size = 0;

  // 边写边算哈希，同时限制大小
  const hasher = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        cb(new AppError(ErrorCode.FILE_TOO_LARGE));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(file.file, hasher, createWriteStream(tmpPath));
  } catch (e) {
    await unlink(tmpPath).catch(() => undefined);
    if (e instanceof AppError) throw e;
    // fastify-multipart 在超限时抛的错也归为文件过大
    throw new AppError(ErrorCode.FILE_TOO_LARGE);
  }

  if (size === 0) {
    await unlink(tmpPath).catch(() => undefined);
    throw new AppError(ErrorCode.UPLOAD_INCOMPLETE, '文件为空');
  }

  const sha256 = hash.digest('hex');
  const relPath = storagePathFor(sha256, ext);
  const finalPath = join(config.upload.dir, relPath);

  // ---------- 去重：同内容已存在则复用，不重复占盘 ----------
  const existingRows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.sha256, sha256))
    .limit(1);

  const existing = existingRows[0];
  if (existing) {
    // 保留已有文件，删除本次临时文件
    await unlink(tmpPath).catch(() => undefined);
    log.info({ sha256, attachmentId: existing.id }, '文件已存在，复用');
    return { attachment: toAttachmentDto(existing), deduplicated: true };
  }

  // ---------- 原子落盘 ----------
  await mkdir(join(config.upload.dir, relPath, '..'), { recursive: true });
  await rename(tmpPath, finalPath);

  // 校验落盘大小，防止磁盘写满导致的静默截断
  const written = await stat(finalPath);
  if (written.size !== size) {
    await unlink(finalPath).catch(() => undefined);
    throw new AppError(ErrorCode.UPLOAD_INCOMPLETE, '文件写入不完整，请重试');
  }

  // ---------- 入库 ----------
  const id = newId();
  const now = Date.now();

  await db.insert(attachments).values({
    id,
    uploaderId,
    kind,
    filename: originalName,
    mime,
    size,
    sha256,
    storagePath: relPath,
    thumbPath: null,
    width: meta?.width ?? null,
    height: meta?.height ?? null,
    durationMs: meta?.durationMs ?? null,
    waveform: meta?.waveform ?? null,
    messageId: null,
    sortOrder: 0,
    createdAt: now,
    // 服务器只保留 ATTACHMENT_TTL_DAYS 天，到期后定时任务删文件并置 expiredAt
    expiresAt: now + ATTACHMENT_TTL_MS,
    expiredAt: null,
  });

  const rows = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new AppError(ErrorCode.INTERNAL_ERROR);

  log.info({ attachmentId: id, size, kind, sha256: sha256.slice(0, 12) }, '上传完成');

  return { attachment: toAttachmentDto(row), deduplicated: false };
}

/* ------------------------------------------------------------------ */
/* 媒体读取（供 /api/media/:id 使用）                                    */
/* ------------------------------------------------------------------ */

export interface MediaLookup {
  id: string;
  storagePath: string;
  filename: string;
  mime: string;
  size: number;
  /** 是否已过期（文件已被清理） */
  expired: boolean;
}

/**
 * 按 id 查附件，返回内部文件路径信息
 * 已过期的附件会带上 expired 标记，路由层据此返回 410 Gone，
 * 让客户端能明确区分「文件过期」与「链接写错」。
 */
export async function findAttachment(attachmentId: string): Promise<MediaLookup> {
  const rows = await db
    .select({
      id: attachments.id,
      storagePath: attachments.storagePath,
      filename: attachments.filename,
      mime: attachments.mime,
      size: attachments.size,
      expiredAt: attachments.expiredAt,
      expiresAt: attachments.expiresAt,
    })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new AppError(ErrorCode.ATTACHMENT_NOT_FOUND);

  const expired =
    (row.expiredAt !== null && row.expiredAt > 0) ||
    (row.expiresAt > 0 && row.expiresAt <= Date.now());

  return {
    id: row.id,
    storagePath: row.storagePath,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    expired,
  };
}

/** 打开文件流（Range 请求由 OpenResty 处理，这里只负责读整个文件） */
export function openMediaStream(storagePath: string) {
  return createReadStream(join(config.upload.dir, storagePath));
}

/**
 * 清理孤儿附件
 * 说明：用户上传后没点发送的附件会一直占磁盘，
 *      定时任务把「超过 24 小时且未绑定消息」的附件删掉。
 */
export async function cleanupOrphanAttachments(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  const { and, isNull, lt } = await import('drizzle-orm');
  const cutoff = Date.now() - olderThanMs;

  const rows = await db
    .select({ id: attachments.id, storagePath: attachments.storagePath })
    .from(attachments)
    .where(and(isNull(attachments.messageId), lt(attachments.createdAt, cutoff)))
    .limit(500);

  for (const row of rows) {
    await unlink(join(config.upload.dir, row.storagePath)).catch(() => undefined);
    await db.delete(attachments).where(eq(attachments.id, row.id));
  }

  if (rows.length > 0) log.info({ count: rows.length }, '清理孤儿附件');
  return rows.length;
}

/**
 * 清理过期聊天文件（释放磁盘空间的核心任务）
 * ============================================================
 * 【关键设计：只删文件，不删记录】
 *
 * 到期后执行：
 *   1. unlink 磁盘上的文件（图片/视频/语音/文件本体）；
 *   2. 把 expiredAt 写成当前时间；
 *   3. **保留 attachments 行与 messages 行**。
 *
 * 这样做的原因：
 *   - 聊天记录不会出现空洞：消息的时间、发送者、类型都还在，
 *     客户端收到 expired=true 的附件后显示「文件已过期」占位；
 *   - 用户能看到「这里曾经发过一个文件」，符合微信/TG 的体验；
 *   - 若直接删 attachments 行，消息就变成一条没有任何内容的空消息，
 *     用户会以为聊天记录丢失。
 *
 * 【磁盘真正释放点】
 * 同一 sha256 可能被多条 attachment 行引用（内容寻址去重）。
 * 因此必须确认「该 sha256 已无任何未过期引用」才能删物理文件，
 * 否则会把别人还在用的文件删掉。
 *
 * 每次只处理 batchSize 条，避免一次性扫全表把 2 核机器压满。
 * ============================================================
 */
export async function cleanupExpiredAttachments(batchSize = 200): Promise<{
  filesDeleted: number;
  bytesFreed: number;
  marked: number;
}> {
  const { and, isNull, lte, ne } = await import('drizzle-orm');
  const now = Date.now();

  // 待处理：已到期、且尚未标记过期
  const rows = await db
    .select({
      id: attachments.id,
      sha256: attachments.sha256,
      storagePath: attachments.storagePath,
      thumbPath: attachments.thumbPath,
      size: attachments.size,
    })
    .from(attachments)
    .where(and(lte(attachments.expiresAt, now), isNull(attachments.expiredAt)))
    .limit(batchSize);

  if (rows.length === 0) return { filesDeleted: 0, bytesFreed: 0, marked: 0 };

  let filesDeleted = 0;
  let bytesFreed = 0;

  for (const row of rows) {
    /**
     * 内容寻址去重：同一 sha256 可能被多条 attachment 引用。
     * 只有「除自己以外没有任何未过期引用」时才能删物理文件，
     * 否则会把其他用户还在用的文件删掉。
     */
    const otherLiveRows = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.sha256, row.sha256),
          ne(attachments.id, row.id),
          isNull(attachments.expiredAt),
        ),
      )
      .limit(1);

    if (otherLiveRows.length === 0) {
      try {
        await unlink(join(config.upload.dir, row.storagePath));
        filesDeleted += 1;
        bytesFreed += row.size;
      } catch {
        // 文件可能已不存在（人工清理过），继续标记即可
      }
      if (row.thumbPath) {
        await unlink(join(config.upload.dir, row.thumbPath)).catch(() => undefined);
      }
    }

    // 无论文件是否删除成功都标记过期，避免同一条记录被反复扫描
    await db.update(attachments).set({ expiredAt: now }).where(eq(attachments.id, row.id));
  }

  log.info(
    { marked: rows.length, filesDeleted, mb: (bytesFreed / 1024 / 1024).toFixed(1) },
    '清理过期聊天文件',
  );

  return { filesDeleted, bytesFreed, marked: rows.length };
}
