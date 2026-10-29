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
}

/** 按 id 查附件，返回内部文件路径信息 */
export async function findAttachment(attachmentId: string): Promise<MediaLookup> {
  const rows = await db
    .select({
      id: attachments.id,
      storagePath: attachments.storagePath,
      filename: attachments.filename,
      mime: attachments.mime,
      size: attachments.size,
    })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new AppError(ErrorCode.ATTACHMENT_NOT_FOUND);
  return row;
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
