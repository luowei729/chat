/**
 * ============================================================
 * 跨平台媒体能力层（唯一出口）
 * ============================================================
 * 设计铁律（用户明确要求：功能必须全平台可用）
 *
 *   1. **业务逻辑不下沉原生**。
 *      原生只提供「能力原子」：选图、拍照、录像、选文件、
 *      录音、播放、把文件按 multipart 传到指定 URL。
 *      上传地址、鉴权头、响应解析、错误文案全部在 JS 层。
 *
 *   2. **能力探测，不做平台判断**。
 *      判断 `native.pickImage` 是否存在，而不是 `platform === 'android'`。
 *      这样 iOS / HarmonyOS / Windows / macOS 只要按同一份
 *      方法名实现原生模块，JS 层零改动即可跑起来。
 *
 *   3. **必须有 Web 兜底**。
 *      桌面端与 Web 端走 `<input type="file">` + `MediaRecorder` +
 *      `FileReader`，保证「能力缺失时降级但不断路」。
 *
 *   4. **页面只 import 这里**，禁止页面直接碰 lynx.getJSModule。
 *
 * ------------------------------------------------------------
 * 原生模块契约（各端按此实现，方法名/参数/返回完全一致）
 * ------------------------------------------------------------
 *   pickImage(optsJson, callback)   opts={multiple:boolean}  → {ok, files:FileResult[]}
 *   openCamera(optsJson, callback)  opts={flash:boolean}     → {ok, file:FileResult}
 *       微信式相机页：轻触拍照、长按录像、右上角闪光灯开关。
 *       手势判定在原生层实现（300ms 阈值），前端只拿结果。
 *   pickFile(optsJson, callback)    opts={mimeFilter:string} → {ok, files:FileResult[]}
 *   startRecord(callback)                                    → {ok:boolean}
 *   stopRecord(callback)                                     → FileResult & {durationMs, waveform}
 *   cancelRecord(callback)                                   → {ok:boolean}
 *   playAudio(uri, callback)                                 → {ok:boolean, durationMs}
 *   stopAudio(callback)                                      → {ok:boolean}
 *   uploadFile(opts, callback)                               → {status:number, body:string}
 *       opts = { uri, name, mime, url, headers:{k:v}, fields:{k:v} }
 *
 *   FileResult = { uri, name, mime, size, width?, height?, durationMs? }
 *
 * 任何一端没实现某个方法，调用方会自动走 Web 兜底；
 * 兜底也不可用时抛 PlatformMediaError，UI 显示可读提示。
 * ============================================================
 */

import { API_BASE } from '../config.js';
import { authHeaders } from '../api/client.js';
import { getGlobalEventEmitter, getNativeModule } from './globals.js';

/* ------------------------------------------------------------------ */
/* 类型                                                                 */
/* ------------------------------------------------------------------ */

/** 选中/拍摄后拿到的文件描述（各端字段完全一致） */
export interface PickedFile {
  /** 端上可读的文件地址（Android 为 content:// 或 file://） */
  uri: string;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
}

/** 录音结果：比普通文件多了时长与波形 */
export interface RecordedAudio extends PickedFile {
  durationMs: number;
  /** 0~100 的振幅采样，用于画波形条 */
  waveform: number[];
}

export type PickedMediaKind = 'image' | 'video' | 'file';

/** 能力缺失 / 用户取消 / 端上报错 统一成这个异常 */
export class PlatformMediaError extends Error {
  readonly code: 'unsupported' | 'cancelled' | 'failed';
  constructor(code: 'unsupported' | 'cancelled' | 'failed', message: string) {
    super(message);
    this.name = 'PlatformMediaError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* 原生模块获取                                                         */
/* ------------------------------------------------------------------ */

interface ChatMediaNative {
  pickImage?: (optsJson: string, cb: (r: unknown) => void) => void;
  openCamera?: (optsJson: string, cb: (r: unknown) => void) => void;
  pickFile?: (optsJson: string, cb: (r: unknown) => void) => void;
  startRecord?: (cb: (r: unknown) => void) => void;
  stopRecord?: (cb: (r: unknown) => void) => void;
  cancelRecord?: (cb: (r: unknown) => void) => void;
  playAudio?: (uri: string, cb: (r: unknown) => void) => void;
  stopAudio?: (cb: (r: unknown) => void) => void;
  uploadFile?: (opts: unknown, cb: (r: unknown) => void) => void;
}

let cachedNative: ChatMediaNative | null | undefined;

/**
 * 取原生模块
 * ------------------------------------------------------------
 * Lynx 3.x 起用 `lynx.getJSModule(name)`；老版本是全局 NativeModules。
 * 两种都试，拿不到就返回 null —— 调用方据此走 Web 兜底。
 * 结果缓存，避免每次调用都走一遍 getJSModule。
 */
function native(): ChatMediaNative | null {
  if (cachedNative !== undefined) return cachedNative;
  // 不做负缓存：模块可能在首帧之后才注册
  cachedNative = getNativeModule<ChatMediaNative>('ChatMedia');
  return cachedNative;
}

/** 该端是否具备原生媒体能力（UI 可据此隐藏「拍摄」等入口） */
export function hasNativeMedia(): boolean {
  return native() !== null;
}

/** 单个能力是否可用 */
export function can(kind: MediaCapability): boolean {
  const n = native();
  if (n && typeof n[capabilityMethod(kind)] === 'function') return true;
  return webCapability(kind);
}

export type MediaCapability =
  | 'pickImage'
  /** 相机（拍照 + 录像 一体，微信式手势） */
  | 'camera'
  | 'pickFile'
  | 'record'
  | 'playAudio';

function capabilityMethod(kind: MediaCapability): keyof ChatMediaNative {
  switch (kind) {
    case 'pickImage':
      return 'pickImage';
    case 'camera':
      return 'openCamera';
    case 'pickFile':
      return 'pickFile';
    case 'record':
      return 'startRecord';
    case 'playAudio':
      return 'playAudio';
  }
}

/* ------------------------------------------------------------------ */
/* 通用调用包装                                                         */
/* ------------------------------------------------------------------ */

/**
 * 调用原生方法并转成 Promise
 * ------------------------------------------------------------
 * 原生回调统一返回对象：
 *   { ok:true, ...数据 }  成功
 *   { ok:false, cancelled:true }  用户取消
 *   { ok:false, message:'...' }   失败
 * 这样各端不用自己定义错误码，JS 层统一翻译。
 */
function callNative<T>(
  method: keyof ChatMediaNative,
  args: unknown[],
  onProgress?: (ratio: number) => void,
): Promise<T> {
  const n = native();
  const fn = n?.[method] as
    | ((...a: unknown[]) => void)
    | undefined;
  if (!n || typeof fn !== 'function') {
    return Promise.reject(new PlatformMediaError('unsupported', '当前平台不支持该操作'));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cb = (raw: unknown) => {
      if (settled) return;

      const r0 = (raw ?? {}) as Record<string, unknown>;

      /**
       * 进度帧
       * ------------------------------------------------------------
       * 原生上传会把同一个 callback 多次 invoke：
       *   {pending:true, progress:0.42}  → 进度
       *   {ok:true, status:201, body:..} → 最终结果
       * 所以必须先拦 progress 帧，不能当最终结果处理，
       * 否则第一条进度就会让 Promise 提前 resolve（拿到半个响应）。
       */
      if (r0['pending'] === true) {
        if (onProgress && typeof r0['progress'] === 'number') {
          onProgress(r0['progress'] as number);
        }
        return;
      }

      settled = true;
      const r = r0;
      if (r['ok'] === true) {
        resolve(r as T);
        return;
      }
      if (r['cancelled'] === true) {
        reject(new PlatformMediaError('cancelled', '已取消'));
        return;
      }
      reject(
        new PlatformMediaError(
          'failed',
          typeof r['message'] === 'string' ? r['message'] : '操作失败',
        ),
      );
    };

    try {
      fn.call(n, ...args, cb);
    } catch (e) {
      settled = true;
      reject(
        new PlatformMediaError(
          'failed',
          e instanceof Error ? e.message : '原生调用异常',
        ),
      );
    }
  });
}

/* ------------------------------------------------------------------ */
/* 上传进度（全局事件通道）                                              */
/* ------------------------------------------------------------------ */
/**
 * 为什么进度不走 Callback
 * ------------------------------------------------------------
 * Lynx 的 Callback 是**一次性**的：第一次 invoke 之后即失效。
 * 之前用它上报进度，导致第一个进度帧发出后，后续进度与最终结果
 * 全部丢失 —— Promise 永远挂起，界面卡在「发送中 0%」。
 *
 * 现在：进度走原生全局事件（可无限广播），
 *       Callback 只用于最终结果（保证只调用一次）。
 * uploadId 把两边配对起来。
 */
type ProgressListener = (ratio: number) => void;
const progressListeners = new Map<string, ProgressListener>();
let progressSubscribed = false;

function ensureProgressSubscribed(): void {
  if (progressSubscribed) return;
  const emitter = getGlobalEventEmitter();
  if (!emitter) return;
  progressSubscribed = true;

  try {
    emitter.addListener('uploadProgress', (...args: unknown[]) => {
      // 原生按 (uploadId, ratio) 两个参数推送
      const id = typeof args[0] === 'string' ? args[0] : '';
      const ratio = typeof args[1] === 'number' ? args[1] : 0;
      const cb = progressListeners.get(id);
      if (cb) cb(ratio);
    });
  } catch {
    progressSubscribed = false;
  }
}

/** 生成一个上传 id（与消息 clientId 无关，仅用于进度配对） */
function newUploadId(): string {
  return `up${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ */
/* 选图 / 拍照 / 录像 / 选文件                                          */
/* ------------------------------------------------------------------ */

/** 相册选图（可多选） */
export async function pickImages(multiple = true): Promise<PickedFile[]> {
  if (native()?.pickImage) {
    const r = await callNative<{ files?: PickedFile[] }>('pickImage', [
      JSON.stringify({ multiple }),
    ]);
    return r.files ?? [];
  }
  return webPickFiles('image/*', multiple);
}

/**
 * 打开相机（微信式）
 * ------------------------------------------------------------
 * 一个入口同时覆盖拍照与录像，因为两者的手势是同一个按钮：
 *   轻触 → 拍照
 *   长按 → 录像（松手结束，上滑取消）
 * 闪光灯开关在页面内，不占用前端 UI。
 *
 * @param flash 初始闪光灯状态
 * @returns 拍到的文件（图片或视频）
 */
export async function openCamera(flash = false): Promise<PickedFile> {
  if (native()?.openCamera) {
    const r = await callNative<{ file?: PickedFile }>('openCamera', [
      JSON.stringify({ flash }),
    ]);
    if (!r.file) throw new PlatformMediaError('failed', '没有拿到拍摄结果');
    return r.file;
  }
  // Web/桌面端：浏览器不支持同一按钮双模态，
  // 退化为「先问拍照片还是录像」由调用方决定，这里默认拍照。
  const files = await webPickFiles('image/*,video/*', false, 'environment');
  if (files.length === 0) throw new PlatformMediaError('cancelled', '已取消');
  return files[0]!;
}

/** 系统文件选择器（任意文件） */
export async function pickFile(): Promise<PickedFile[]> {
  if (native()?.pickFile) {
    const r = await callNative<{ files?: PickedFile[] }>('pickFile', [
      JSON.stringify({ mimeFilter: '*/*' }),
    ]);
    return r.files ?? [];
  }
  return webPickFiles('*/*', true);
}

/* ------------------------------------------------------------------ */
/* 录音                                                                 */
/* ------------------------------------------------------------------ */

/** 正在录音的端能力（供 UI 判断按钮可用性） */
export function hasRecorder(): boolean {
  return typeof native()?.startRecord === 'function' || webRecorderAvailable();
}

/** 开始录音 */
export async function startVoiceRecord(): Promise<void> {
  if (native()?.startRecord) {
    await callNative<unknown>('startRecord', []);
    return;
  }
  await webStartRecord();
}

/** 停止录音并拿到结果 */
export async function stopVoiceRecord(): Promise<RecordedAudio> {
  if (native()?.stopRecord) {
    const r = await callNative<{ file?: RecordedAudio }>('stopRecord', []);
    if (!r.file) throw new PlatformMediaError('failed', '录音失败');
    return r.file;
  }
  return webStopRecord();
}

/** 取消录音（不产生文件） */
export async function cancelVoiceRecord(): Promise<void> {
  if (native()?.cancelRecord) {
    await callNative<unknown>('cancelRecord', []);
    return;
  }
  webCancelRecord();
}

/* ------------------------------------------------------------------ */
/* 音频播放                                                             */
/* ------------------------------------------------------------------ */

/** 播放一段音频（语音条） */
export async function playAudio(uri: string): Promise<void> {
  if (native()?.playAudio) {
    await callNative<unknown>('playAudio', [uri]);
    return;
  }
  webPlayAudio(uri);
}

/** 停止播放 */
export async function stopAudio(): Promise<void> {
  if (native()?.stopAudio) {
    await callNative<unknown>('stopAudio', []);
    return;
  }
  webStopAudio();
}

/* ------------------------------------------------------------------ */
/* 上传                                                                 */
/* ------------------------------------------------------------------ */

export interface UploadMeta {
  kind?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  waveform?: number[];
}

export interface UploadResponse {
  attachment: {
    id: string;
    kind: string;
    filename: string;
    mime: string;
    size: number;
    url: string;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    waveform?: number[] | null;
  };
  deduplicated: boolean;
}

/**
 * 上传文件
 * ------------------------------------------------------------
 * 原生端用 OkHttp 直传（流式，不吃内存）；
 * Web/桌面端用 fetch + FormData。
 * 两条路返回完全相同的 JSON 结构，业务层无感知。
 *
 * 注意：这里自己拼 URL 与鉴权头，而不是复用 api/client 的 post，
 * 因为 multipart 走不了统一的 JSON 编解码路径。
 */
export async function uploadPicked(
  file: PickedFile,
  meta?: UploadMeta,
  onProgress?: (ratio: number) => void,
): Promise<UploadResponse> {
  const url = `${API_BASE}/media`;
  // 上传前刷新令牌：access token 只有 15 分钟，
  // 原生上传不走 rawFetch，必须自己保证新鲜度
  const headers = await authHeaders();

  const fields: Record<string, string> = {};
  if (meta?.kind) fields['kind'] = meta.kind;
  if (meta?.width !== undefined) fields['width'] = String(meta.width);
  if (meta?.height !== undefined) fields['height'] = String(meta.height);
  if (meta?.durationMs !== undefined) fields['durationMs'] = String(meta.durationMs);
  if (meta?.waveform) fields['waveform'] = JSON.stringify(meta.waveform);

  let bodyText: string;

  if (native()?.uploadFile) {
    /**
     * 注册进度监听后再发起上传
     * 注意顺序：必须先 add 再调用原生，否则首批进度帧会丢。
     */
    const uploadId = newUploadId();
    if (onProgress) {
      ensureProgressSubscribed();
      progressListeners.set(uploadId, onProgress);
    }

    let r: { status?: number; body?: string };
    try {
      r = await callNative<{ status?: number; body?: string }>('uploadFile', [
        JSON.stringify({
          uploadId,
          uri: file.uri,
          name: file.name,
          mime: file.mime,
          url,
          headers,
          fields,
        }),
      ]);
    } finally {
      progressListeners.delete(uploadId);
    }
    const status = Number(r.status ?? 0);
    bodyText = String(r.body ?? '');
    if (status === 401) throw new PlatformMediaError('failed', '登录已过期，请重新登录');
    if (status < 200 || status >= 300) {
      throw new PlatformMediaError('failed', extractMessage(bodyText) ?? '上传失败');
    }
  } else {
    bodyText = await webUpload(file, url, headers, fields);
  }

  const parsed = safeJson(bodyText);
  const payload = parsed as
    | { code?: number; message?: string; data?: UploadResponse }
    | null;
  if (!payload || payload.code !== 0 || !payload.data) {
    throw new PlatformMediaError(
      'failed',
      payload?.message ?? '上传失败，请重试',
    );
  }
  return payload.data;
}

function extractMessage(body: string): string | null {
  const j = safeJson(body) as { message?: string } | null;
  return typeof j?.message === 'string' ? j.message : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Web / 桌面端兜底实现                                                 */
/* ------------------------------------------------------------------ */
/**
 * 为什么这里全是 any
 * ------------------------------------------------------------
 * 本工程 tsconfig 的 lib 只有 ES2020，没有 DOM 类型
 * （Lynx 的目标不是浏览器，引入 DOM 类型会污染 Lynx 元素推导）。
 * 但 Web / 桌面端确实要调 DOM API，所以在这一节用最小化的
 * 结构化接口声明我们用到的那几个成员，其余一律 any。
 * 好处：类型安全边界清晰，且不会把 DOM 泄漏到业务代码里。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type AnyRec = Record<string, any>;

/** 构造器类型：DOM 构造器在无 DOM lib 时只能这样声明 */
type AnyCtor = new (...args: any[]) => any;

function globals(): AnyRec {
  return globalThis as unknown as AnyRec;
}

/** 取 DOM document（Lynx 原生端不存在） */
function doc(): AnyRec | null {
  return globals()['document'] ?? null;
}

function webCapability(kind: MediaCapability): boolean {
  const g = globals();
  if (!doc()) return false;
  if (kind === 'record') return webRecorderAvailable();
  if (kind === 'playAudio') return typeof g['Audio'] === 'function';
  return true;
}

function webRecorderAvailable(): boolean {
  const g = globals();
  return typeof g['MediaRecorder'] === 'function';
}

/** Web 选文件：动态创建 input，选完即销毁 */
function webPickFiles(
  accept: string,
  multiple: boolean,
  capture?: 'user' | 'environment',
): Promise<PickedFile[]> {
  const d = doc();
  if (!d) {
    return Promise.reject(
      new PlatformMediaError('unsupported', '当前平台不支持选择文件，请用 App 端操作'),
    );
  }

  return new Promise<PickedFile[]>((resolve, reject) => {
    const input = d.createElement('input') as AnyRec;
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute('capture', capture);
    input.style.display = 'none';

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        input.remove();
      } catch {
        // 忽略
      }
      fn();
    };

    input.onchange = () => {
      const list = input.files as AnyRec | null;
      const n = Number(list?.length ?? 0);
      if (n === 0) {
        finish(() => reject(new PlatformMediaError('cancelled', '已取消')));
        return;
      }
      const files: PickedFile[] = [];
      for (let i = 0; i < n; i++) {
        const f = list?.[i] as AnyRec;
        const uri = `web-object-url:${String(f?.name ?? 'file')}`;
        // 浏览器 File 对象无法从 uri 反查，这里留住引用供上传时使用
        if (f) pickedWebFiles.set(uri, f);
        files.push({
          uri,
          name: String(f?.name ?? 'file'),
          mime: String(f?.type || 'application/octet-stream'),
          size: Number(f?.size ?? 0),
        });
      }
      finish(() => resolve(files));
    };

    // 用户点「取消」不会触发 change，用窗口 focus 兜底
    const onFocus = () => {
      const setT = globals()['setTimeout'] as
        | ((fn: () => void, ms: number) => void)
        | undefined;
      setT?.(() => {
        if (!settled) {
          finish(() => reject(new PlatformMediaError('cancelled', '已取消')));
        }
      }, 800);
    };
    (globals()['addEventListener'] as AnyRec | undefined)?.call?.(
      globals(),
      'focus',
      onFocus,
      { once: true },
    );

    (d['body'] as AnyRec).appendChild(input);
    input.click();
  });
}

/**
 * Web 上传
 * ------------------------------------------------------------
 * 浏览器端 file 输入产生的 File 对象无法通过 uri 找回，
 * 所以这里把最后一次选中的 File 缓存在 webPickFiles 里。
 * 见 pickedWebFiles。
 */
const pickedWebFiles = new Map<string, AnyRec>();

async function webUpload(
  file: PickedFile,
  url: string,
  headers: Record<string, string>,
  fields: Record<string, string>,
): Promise<string> {
  const g = globals();
  const fetchFn = g['fetch'] as AnyRec | undefined;
  const FormDataCtor = g['FormData'] as AnyCtor | undefined;
  if (typeof fetchFn !== 'function' || typeof FormDataCtor !== 'function') {
    throw new PlatformMediaError('unsupported', '当前平台不支持上传，请用 App 端操作');
  }

  const fd = new FormDataCtor() as AnyRec;
  const cached = pickedWebFiles.get(file.uri);
  if (cached) {
    fd['append']('file', cached, file.name);
  } else {
    const BlobCtor = g['Blob'] as AnyCtor;
    // 兜底：空文件，至少让服务端返回明确错误而不是卡住
    fd['append']('file', new BlobCtor([], { type: file.mime }), file.name);
  }
  fd['append']
  for (const k of Object.keys(fields)) fd['append'](k, fields[k]);

  const resp = (await fetchFn(url, {
    method: 'POST',
    headers,
    body: fd,
  })) as AnyRec;
  return String(resp.text());
}

/* --- Web 录音 --- */

interface WebRecorderState {
  recorder: AnyRec;
  chunks: unknown[];
  stream: AnyRec;
  startedAt: number;
}

let webRecorder: WebRecorderState | null = null;

async function webStartRecord(): Promise<void> {
  const g = globals();
  const MediaRecorderCtor = g['MediaRecorder'] as AnyCtor | undefined;
  const nav = g['navigator'] as AnyRec | undefined;
  const getUserMedia = nav?.['mediaDevices']?.['getUserMedia'] as
    | ((c: unknown) => Promise<AnyRec>)
    | undefined;

  if (typeof MediaRecorderCtor !== 'function' || !getUserMedia) {
    throw new PlatformMediaError('unsupported', '当前平台不支持录音');
  }

  const stream = await getUserMedia({ audio: true });
  const chunks: unknown[] = [];
  const recorder = new MediaRecorderCtor(stream);
  recorder.ondataavailable = (e: AnyRec) => {
    if (e?.['data'] && Number(e['data'].size) > 0) chunks.push(e['data']);
  };
  recorder.start();

  webRecorder = { recorder, chunks, stream, startedAt: Date.now() };
}

async function webStopRecord(): Promise<RecordedAudio> {
  const st = webRecorder;
  if (!st) throw new PlatformMediaError('failed', '没有正在进行的录音');
  webRecorder = null;

  const durationMs = Date.now() - st.startedAt;
  await new Promise<void>((resolve) => {
    st.recorder.onstop = () => resolve();
    try {
      st.recorder.stop();
    } catch {
      resolve();
    }
  });
  (st.stream['getTracks'] as () => AnyRec[])().forEach((t) => t['stop']());

  const g = globals();
  const BlobCtor = g['Blob'] as AnyCtor;
  const blob = new BlobCtor(st.chunks, { type: 'audio/webm' }) as AnyRec;
  const name = `voice-${Date.now()}.webm`;
  const uri = `web-object-url:${name}`;
  pickedWebFiles.set(uri, blob);

  return {
    uri,
    name,
    mime: 'audio/webm',
    size: Number(blob['size'] ?? 0),
    durationMs,
    waveform: [],
  };
}

function webCancelRecord(): void {
  const st = webRecorder;
  webRecorder = null;
  if (!st) return;
  try {
    st.recorder.stop();
  } catch {
    // 忽略
  }
  (st.stream['getTracks'] as () => AnyRec[])().forEach((t) => t['stop']());
}

/* --- Web 播放 --- */

let webAudio: AnyRec | null = null;

function webPlayAudio(uri: string): void {
  const g = globals();
  const AudioCtor = g['Audio'] as AnyCtor | undefined;
  if (typeof AudioCtor !== 'function') {
    throw new PlatformMediaError('unsupported', '当前平台不支持播放');
  }
  webStopAudio();
  const el = new AudioCtor(uri) as AnyRec;
  webAudio = el;
  void el['play']();
}

function webStopAudio(): void {
  if (!webAudio) return;
  try {
    webAudio['pause']();
    webAudio['currentTime'] = 0;
  } catch {
    // 忽略
  }
  webAudio = null;
}
