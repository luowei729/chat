/**
 * ============================================================
 * 媒体查看器（图片 / 视频全屏预览）
 * ============================================================
 * 交互（对齐 Telegram / 微信）：
 *   - 点击任意空白处 / 返回键  → 关闭
 *   - 图片：aspectFit 完整显示，深色背景衬托
 *   - 视频：原生 player 控件，点击播放
 *
 * 为什么单独做页面而不是在气泡里放大：
 * 1. 气泡内受 maxWidth 约束，无法真正全屏；
 * 2. 全屏后需要接管返回键，用页面栈最自然；
 * 3. 图片地址必须用绝对 URL（见 config.mediaUrl），
 *    否则 Lynx 的 <image> 静默失败。
 * ============================================================
 */

import { useState } from '@lynx-js/react';
import { pop } from '../router.js';
import { mediaUrl } from '../config.js';
import { IconClose } from './Icons.js';
import { colors, fontSize, radius, spacing } from '../theme.js';

export interface MediaViewerParams {
  /** 服务端返回的媒体地址（相对或绝对均可，内部会绝对化） */
  url: string;
  /** image | video */
  kind: 'image' | 'video';
  /** 文件名，用于视频下载提示 */
  filename?: string;
}

export function MediaViewerPage(props: MediaViewerParams) {
  const { url, kind, filename } = props;
  const [failed, setFailed] = useState(false);
  /**
   * 加载中
   * ------------------------------------------------------------
   * 图片/视频从服务端拉取有延迟（大图尤其明显），
   * 没有加载态时用户只看到一片黑，会以为功能坏了。
   * 这里在内容就绪前盖一层「加载中」。
   * 事件选择：
   *   图片 → bindload（解码完成）
   *   视频 → bindfirstframe（已有可显示画面）；
   *          bindloadedmetadata 在 Lynx 的 VideoProps 里不存在。
   */
  const [loading, setLoading] = useState(true);
  const src = mediaUrl(url);

  return (
    <view
      style={{
        width: '100%',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#000000',
      }}
      bindtap={pop}
    >
      {/* 顶栏：关闭按钮 + 文件名 */}
      <view
        style={{
          width: '100%',
          height: '56px',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: spacing.md,
          paddingRight: spacing.md,
        }}
      >
        <view
          style={{
            width: '40px',
            height: '40px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          bindtap={pop}
        >
          <IconClose size={22} color="#FFFFFF" />
        </view>
        <text
          style={{
            color: 'rgba(255,255,255,0.72)',
            fontSize: fontSize.sm,
            marginLeft: spacing.sm,
          }}
          text-maxline="1"
        >
          {filename ?? ''}
        </text>
      </view>

      {/* 内容区：绝对定位撑满剩余空间，避免 flex:1 在 Lynx 下塌陷 */}
      <view
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: '56px',
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {failed ? (
          <view style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <text style={{ color: 'rgba(255,255,255,0.6)', fontSize: fontSize.md }}>
              无法加载该文件
            </text>
            <text
              style={{
                color: 'rgba(255,255,255,0.4)',
                fontSize: fontSize.xs,
                marginTop: spacing.sm,
              }}
            >
              可能已超过 30 天保留期
            </text>
          </view>
        ) : kind === 'video' ? (
          <video
            src={src}
            style={{ width: '100%', height: '100%' }}
            auto-play={false}
            muted={false}
            /* 首帧事件 = 已有可显示画面，最贴近「加载完成」 */
            bindfirstframe={() => setLoading(false)}
            bindbuffering={() => setLoading(true)}
            bindplaying={() => setLoading(false)}
            bindended={() => setLoading(false)}
            bindstopped={() => setLoading(false)}
            binderror={() => {
              setLoading(false);
              setFailed(true);
            }}
          />
        ) : (
          <image
            src={src}
            style={{ width: '100%', height: '100%' }}
            mode="aspectFit"
            bindload={() => setLoading(false)}
            binderror={() => {
              setLoading(false);
              setFailed(true);
            }}
          />
        )}

        {/* 加载遮罩 */}
        {loading && !failed ? (
          <view
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: '#000000',
            }}
          >
            {/* 转圈：用旋转的圆环模拟（Lynx 无 CSS animation，用 12 段圆弧拼） */}
            <view
              style={{
                width: '34px',
                height: '34px',
                borderRadius: '17px',
                borderWidth: '3px',
                borderColor: 'rgba(255,255,255,0.18)',
                borderTopColor: 'rgba(255,255,255,0.9)',
              }}
            />
            <text
              style={{
                color: 'rgba(255,255,255,0.55)',
                fontSize: fontSize.sm,
                marginTop: spacing.md,
              }}
            >
              {kind === 'video' ? '视频加载中…' : '图片加载中…'}
            </text>
          </view>
        ) : null}
      </view>

      {/* 底部提示 */}
      <view
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: '24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <text style={{ color: 'rgba(255,255,255,0.35)', fontSize: fontSize.xs }}>
          点击任意处关闭
        </text>
      </view>
    </view>
  );
}
