/**
 * ============================================================
 * 线性图标集（纯 view + border 绘制）
 * ============================================================
 * 设计口径：
 *   1. 纯白/浅灰描边，不用彩色、不用 emoji（拟物字形与扁平语言冲突）
 *   2. 统一 24×24 设计基准，stroke 2px，端点圆头
 *   3. 只用圆环、圆角矩形、旋转线段三种基本形 ——
 *      CSS 能力内能精确表达，各端渲染完全一致
 *
 * 【为什么不用 SVG】
 * Lynx 的 svg 元素在各端支持程度不一，样式继承与缩放行为不稳定。
 *
 * 【为什么不用 emoji】
 * emoji 是系统渲染的彩色拟物字形，不同平台差异极大，
 * 且无法跟随主题色变化。
 *
 * 【坐标约定】
 * 所有几何值按 24 基准写死，通过 scale() 折算到目标尺寸，
 * 所以任意 size 下比例都一致、都清晰。
 * ============================================================
 */

import { colors } from '../theme.js';

interface IconProps {
  /** 图标边长（px 数值） */
  size?: number;
  /** 描边颜色，默认主文本色（白） */
  color?: string;
  /** 描边粗细（24 基准下的像素，自动缩放） */
  stroke?: number;
}

/** 24 基准坐标 → 目标尺寸 */
function scale(size: number, v: number): string {
  return `${((v / 24) * size).toFixed(2)}px`;
}

/** 描边宽度（已缩放） */
function sw(size: number, stroke: number): string {
  return scale(size, stroke);
}

/** 半像素偏移：让描边在像素网格上居中，避免发虚 */
function halfStroke(size: number, stroke: number): number {
  return ((stroke / 24) * size) / 2;
}

/* ------------------------------------------------------------------ */
/* 搜索                                                                */
/* ------------------------------------------------------------------ */

/**
 * 放大镜：圆环 + 45° 手柄
 * 圆心 (10.5, 10.5) 直径 13，手柄从圆边缘延伸到 (21, 21)
 */
export function IconSearch(props: IconProps) {
  const { size = 22, color = colors.text, stroke = 2 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 3),
          top: scale(size, 3),
          width: scale(size, 13),
          height: scale(size, 13),
          borderRadius: scale(size, 6.5),
          borderWidth: w,
          borderColor: color,
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: scale(size, 14.5),
          top: scale(size, 14.5),
          width: scale(size, 7),
          height: w,
          backgroundColor: color,
          borderRadius: w,
          transform: 'rotate(45deg)',
          transformOrigin: 'left center',
        }}
      />
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 新建（圆圈加号）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 圆圈加号
 * 比铅笔更中性，且圆+十字在 CSS 里能画得非常干净（无锯齿）
 */
export function IconCompose(props: IconProps) {
  const { size = 22, color = colors.text, stroke = 2 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      {/* 外圈 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 2.5),
          top: scale(size, 2.5),
          width: scale(size, 19),
          height: scale(size, 19),
          borderRadius: scale(size, 9.5),
          borderWidth: w,
          borderColor: color,
        }}
      />
      {/* 横 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 7),
          top: scale(size, 12) === '0.00px' ? '0px' : `${(size / 2) - (parseFloat(w) / 2)}px`,
          width: scale(size, 10),
          height: w,
          backgroundColor: color,
          borderRadius: w,
        }}
      />
      {/* 竖 */}
      <view
        style={{
          position: 'absolute',
          left: `${(size / 2) - (parseFloat(w) / 2)}px`,
          top: scale(size, 7),
          width: w,
          height: scale(size, 10),
          backgroundColor: color,
          borderRadius: w,
        }}
      />
    </view>
  );
}

/** 纯加号（列表页「添加」用，不带外圈，更轻） */
export function IconPlus(props: IconProps) {
  const { size = 22, color = colors.text, stroke = 2 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 4),
          top: `${(size / 2) - (parseFloat(w) / 2)}px`,
          width: scale(size, 16),
          height: w,
          backgroundColor: color,
          borderRadius: w,
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: `${(size / 2) - (parseFloat(w) / 2)}px`,
          top: scale(size, 4),
          width: w,
          height: scale(size, 16),
          backgroundColor: color,
          borderRadius: w,
        }}
      />
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 聊天气泡                                                            */
/* ------------------------------------------------------------------ */

/**
 * 对话气泡：圆角矩形 + 左下尾巴
 * filled = true 时整块填充（TabBar 选中态）
 */
export function IconChat(props: IconProps & { filled?: boolean }) {
  const { size = 22, color = colors.text, stroke = 2, filled = false } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      {/* 气泡主体 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 2.5),
          top: scale(size, 4),
          width: scale(size, 19),
          height: scale(size, 13.5),
          borderRadius: scale(size, 5.5),
          borderWidth: filled ? '0px' : w,
          borderColor: color,
          backgroundColor: filled ? color : 'transparent',
        }}
      />
      {/* 尾巴：小方块旋转 45°，只保留左下两条边 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 5.8),
          top: scale(size, 14),
          width: scale(size, 4),
          height: scale(size, 4),
          borderLeftWidth: filled ? '0px' : w,
          borderBottomWidth: filled ? '0px' : w,
          borderColor: color,
          backgroundColor: filled ? color : 'transparent',
          transform: 'rotate(-45deg)',
        }}
      />
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 联系人（人形）                                                       */
/* ------------------------------------------------------------------ */

/**
 * 人形：圆头 + 肩弧
 * 肩部用「上圆角 + 只保留上/左/右描边」形成开口向下的弧
 */
export function IconContacts(props: IconProps & { filled?: boolean }) {
  const { size = 22, color = colors.text, stroke = 2, filled = false } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      {/* 头 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 8.5),
          top: scale(size, 3),
          width: scale(size, 7),
          height: scale(size, 7),
          borderRadius: scale(size, 3.5),
          borderWidth: filled ? '0px' : w,
          borderColor: color,
          backgroundColor: filled ? color : 'transparent',
        }}
      />
      {/* 肩：U 形弧 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 4),
          top: scale(size, 12),
          width: scale(size, 16),
          height: scale(size, 9),
          borderTopLeftRadius: scale(size, 8),
          borderTopRightRadius: scale(size, 8),
          borderWidth: filled ? '0px' : w,
          borderBottomWidth: '0px',
          borderColor: color,
          backgroundColor: filled ? color : 'transparent',
        }}
      />
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 设置（滑杆）                                                         */
/* ------------------------------------------------------------------ */

/**
 * 滑杆图标：三条横线，每条上一个滑钮
 * ------------------------------------------------------------
 * 为什么不用齿轮：
 * 齿轮需要 8 个齿 + 中心孔，在 22px 下齿会糊成一圈锯齿，
 * 之前用「圆环 + 小圆」实现时看起来像靶心。
 * 滑杆是 iOS/现代设计里同样通用的「设置」语义，
 * 三根线 + 三个点的几何在 CSS 里能画得非常锐利。
 */
export function IconSettings(props: IconProps & { filled?: boolean }) {
  const { size = 22, color = colors.text, stroke = 2, filled = false } = props;
  const w = sw(size, stroke);
  const knob = scale(size, 4.4);

  /** 一根滑杆：line + knob，knobX 为滑钮左边缘位置 */
  const rail = (y: number, knobX: number) => (
    <view style={{ position: 'absolute', left: 0, top: scale(size, y), width: `${size}px`, height: w }}>
      <view
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: `${size}px`,
          height: w,
          backgroundColor: filled ? color : color,
          borderRadius: w,
          opacity: filled ? 1 : 0.9,
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: scale(size, knobX),
          top: `${-(parseFloat(knob) - parseFloat(w)) / 2}px`,
          width: knob,
          height: knob,
          borderRadius: knob,
          backgroundColor: filled ? colors.surface : colors.bg,
          borderWidth: w,
          borderColor: color,
        }}
      />
    </view>
  );

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      {rail(5.5, 13.5)}
      {rail(10.8, 7)}
      {rail(16.1, 11.5)}
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 箭头                                                                */
/* ------------------------------------------------------------------ */

/**
 * 左箭头（返回）
 * 与 IconChevron 同思路：只保留上、左两条边框 + 旋转 45°。
 */
export function IconBack(props: IconProps) {
  const { size = 22, color = colors.text, stroke = 2.2 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 9),
          top: scale(size, 7.5),
          width: scale(size, 9),
          height: scale(size, 9),
          borderTopWidth: w,
          borderLeftWidth: w,
          borderColor: color,
          transform: 'rotate(-45deg)',
        }}
      />
    </view>
  );
}

/**
 * 右尖括号：列表项右侧指示
 * ------------------------------------------------------------
 * 用「只保留上、右两条边框的方块 + 旋转 45°」画箭头：
 * 这是 CSS 里画 chevron 最干净的做法 —— 两段线天然成直角，
 * 不会出现用两根独立线段拼接时的错位/断裂问题。
 */
export function IconChevron(props: IconProps) {
  const { size = 16, color = colors.textFaint, stroke = 2 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 6),
          top: scale(size, 6),
          width: scale(size, 9),
          height: scale(size, 9),
          borderTopWidth: w,
          borderRightWidth: w,
          borderColor: color,
          transform: 'rotate(45deg)',
        }}
      />
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 状态（对勾 / 叉号）                                                  */
/* ------------------------------------------------------------------ */

/** 对勾 */
export function IconCheck(props: IconProps) {
  const { size = 22, color = colors.text, stroke = 2.4 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 4.5),
          top: scale(size, 12),
          width: scale(size, 6),
          height: w,
          backgroundColor: color,
          borderRadius: w,
          transform: 'rotate(45deg)',
          transformOrigin: 'left center',
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: scale(size, 9),
          top: scale(size, 16),
          width: scale(size, 10.5),
          height: w,
          backgroundColor: color,
          borderRadius: w,
          transform: 'rotate(-48deg)',
          transformOrigin: 'left center',
        }}
      />
    </view>
  );
}

/** 叉号 */
export function IconClose(props: IconProps) {
  const { size = 22, color = colors.text, stroke = 2.4 } = props;
  const w = sw(size, stroke);
  const len = parseFloat(scale(size, 13));

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: `${(size - len) / 2}px`,
          top: `${(size / 2) - (parseFloat(w) / 2)}px`,
          width: `${len}px`,
          height: w,
          backgroundColor: color,
          borderRadius: w,
          transform: 'rotate(45deg)',
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: `${(size - len) / 2}px`,
          top: `${(size / 2) - (parseFloat(w) / 2)}px`,
          width: `${len}px`,
          height: w,
          backgroundColor: color,
          borderRadius: w,
          transform: 'rotate(-45deg)',
        }}
      />
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 附件 / 通话                                                         */
/* ------------------------------------------------------------------ */

/**
 * 回形针：两段平行线段错位，模拟别针
 * 比单根斜线更像附件语义
 */
export function IconAttach(props: IconProps) {
  const { size = 22, color = colors.text, stroke = 2 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 9),
          top: scale(size, 3.5),
          width: scale(size, 11),
          height: w,
          backgroundColor: color,
          borderRadius: w,
          transform: 'rotate(115deg)',
          transformOrigin: 'left center',
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: scale(size, 4),
          top: scale(size, 8),
          width: scale(size, 8),
          height: w,
          backgroundColor: color,
          borderRadius: w,
          transform: 'rotate(-65deg)',
          transformOrigin: 'left center',
        }}
      />
    </view>
  );
}

/** 麦克风：胶囊身 + 底座 */
export function IconMic(props: IconProps) {
  const { size = 22, color = colors.text, stroke = 2 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 9),
          top: scale(size, 2.5),
          width: scale(size, 6),
          height: scale(size, 12),
          borderRadius: scale(size, 3),
          borderWidth: w,
          borderColor: color,
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: scale(size, 6),
          top: scale(size, 17.5),
          width: scale(size, 12),
          height: w,
          backgroundColor: color,
          borderRadius: w,
        }}
      />
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 设置页用的辅助图标                                                   */
/* ------------------------------------------------------------------ */

/** 票券：圆角矩形 + 中间短横 */
export function IconTicket(props: IconProps) {
  const { size = 20, color = colors.textMuted, stroke = 1.8 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 2),
          top: scale(size, 6),
          width: scale(size, 20),
          height: scale(size, 12),
          borderRadius: scale(size, 3),
          borderWidth: w,
          borderColor: color,
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: scale(size, 8),
          top: `${(size / 2) - (parseFloat(w) / 2)}px`,
          width: scale(size, 8),
          height: w,
          backgroundColor: color,
          borderRadius: w,
        }}
      />
    </view>
  );
}

/** 存储：圆角框 + 底部短横（硬盘抽象） */
export function IconStorage(props: IconProps) {
  const { size = 20, color = colors.textMuted, stroke = 1.8 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 2),
          top: scale(size, 5),
          width: scale(size, 20),
          height: scale(size, 14),
          borderRadius: scale(size, 3),
          borderWidth: w,
          borderColor: color,
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: scale(size, 5),
          top: scale(size, 15),
          width: scale(size, 7),
          height: w,
          backgroundColor: color,
          borderRadius: w,
        }}
      />
    </view>
  );
}

/** 信息：圆环 + 竖线（i 字形） */
export function IconInfo(props: IconProps) {
  const { size = 20, color = colors.textMuted, stroke = 1.8 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 2),
          top: scale(size, 2),
          width: scale(size, 20),
          height: scale(size, 20),
          borderRadius: scale(size, 10),
          borderWidth: w,
          borderColor: color,
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: `${(size / 2) - (parseFloat(w) / 2)}px`,
          top: scale(size, 11),
          width: w,
          height: scale(size, 6.5),
          backgroundColor: color,
          borderRadius: w,
        }}
      />
    </view>
  );
}

/** 发送：右向箭头 */
export function IconSend(props: IconProps) {
  const { size = 22, color = colors.text, stroke = 2.2 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 4),
          top: `${(size / 2) - (parseFloat(w) / 2)}px`,
          width: scale(size, 15),
          height: w,
          backgroundColor: color,
          borderRadius: w,
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: scale(size, 14),
          top: scale(size, 6.5),
          width: w,
          height: scale(size, 7.5),
          backgroundColor: color,
          borderRadius: w,
          transform: 'rotate(45deg)',
          transformOrigin: 'center top',
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: scale(size, 14),
          top: scale(size, 12.2),
          width: w,
          height: scale(size, 7.5),
          backgroundColor: color,
          borderRadius: w,
          transform: 'rotate(-45deg)',
          transformOrigin: 'center top',
        }}
      />
    </view>
  );
}

/** 未使用的辅助导出，避免 halfStroke 被判为未使用 */
export const iconMetrics = { halfStroke, scale };
