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

/**
 * 消息状态勾（Telegram 语义）
 * ============================================================
 * 单勾 = 已送达服务器；双勾 = 对方已读。
 *
 * 【几何设计】
 * 一个勾由两条圆头线段组成（下笔 45°、上挑 -48°），
 * 双勾就是把第二个勾整体右移 6 个基准单位，
 * 让它压在第一个勾的上挑段上 —— 和 TG 的叠压关系一致。
 *
 * 【为什么不复用 IconCheck】
 * IconCheck 是 22px 的功能性按钮图标，笔画粗；
 * 这里只有 12~14px，笔画必须细（2.6 基准），
 * 且双勾需要控制整体宽度，否则时间行会被撑开。
 */
export function IconTicks(props: {
  /** true = 双勾（已读） */
  double?: boolean;
  size?: number;
  color?: string;
  stroke?: number;
}) {
  const { double = false, size = 13, color = colors.textFaint, stroke = 2.6 } = props;
  const w = sw(size, stroke);

  /** 单个勾：在 24 基准里占 x∈[3,17]，y∈[11,21] */
  const one = (dx: number, key: string) => (
    <view
      key={key}
      style={{
        position: 'absolute',
        left: scale(size, dx),
        top: 0,
        width: `${size}px`,
        height: `${size}px`,
      }}
    >
      {/* 左侧短笔：45° 落下 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 3),
          top: scale(size, 12.5),
          width: scale(size, 5.6),
          height: w,
          backgroundColor: color,
          borderRadius: w,
          transform: 'rotate(45deg)',
          transformOrigin: 'left center',
        }}
      />
      {/* 右侧长笔：-48° 上挑 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 7.2),
          top: scale(size, 16.4),
          width: scale(size, 9.6),
          height: w,
          backgroundColor: color,
          borderRadius: w,
          transform: 'rotate(-48deg)',
          transformOrigin: 'left center',
        }}
      />
    </view>
  );

  // 双勾整体宽度：24 基准里 x∈[3,23] ≈ 20 个单位
  const boxWidth = double ? `${((20 / 24) * size).toFixed(2)}px` : `${size}px`;

  return (
    <view style={{ width: boxWidth, height: `${size}px`, position: 'relative' }}>
      {double ? one(0, 'first') : null}
      {one(double ? 6 : 0, 'second')}
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

  /**
   * 为什么是「圆圈 + 加号」而不是回形针
   * ------------------------------------------------------------
   * 回形针需要两段 180° 的圆弧互相穿插，在 24px 基准下
   * 无论怎么调参数都会退化成两条断开的斜线（实测过）。
   * 圆圈加号是微信 / iMessage 附件入口的通用语汇，
   * 三笔画得出来、任何尺寸都清晰，信息传达没有损失。
   */
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
          top: `${size / 2 - parseFloat(w) / 2}px`,
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
          left: `${size / 2 - parseFloat(w) / 2}px`,
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

/* ------------------------------------------------------------------ */
/* 聊天输入栏 / 附件面板                                                */
/* ------------------------------------------------------------------ */

/**
 * 电话听筒
 * ============================================================
 * 结构：一个转 -45° 的垂直「哑铃」
 *   上耳罩 10×7、下耳罩 10×7、中间细杆 5×8
 * 这是听筒轮廓的最低成本表达 —— 两端宽、中间细，
 * 旋转后就是斜放的听筒，24px 下依旧可辨。
 *
 * 为什么不用单个圆角方块 + 缺口：
 * 那样做出来更像「回形针」，而哑铃的三段式在缩放时
 * 比例稳定，不会出现端点粘连。
 */
export function IconPhone(props: IconProps) {
  const { size = 22, color = colors.text } = props;

  /**
   * 听筒 = 3/4 圆弧 + 两端大圆头耳罩
   * ------------------------------------------------------------
   * 试错记录（都是实测截图对比过的）：
   *   1. 三段哑铃（上耳罩 / 中杆 / 下耳罩）→ 渲染成哑铃，不像听筒；
   *   2. 两根臂拼 L 再转 -45°          → 内侧圆角形成凹口，变成心形；
   *   3. 符号相反的短翼                 → 变成闪电；
   *   4. 半圆弧 + 端帽                  → 变成笑脸。
   *
   * 最终方案：3/4 圆环（隐藏上边框）转 45°，两端各叠一个小圆把
   * 切角磨圆。圆弧本身就是听筒握柄，开口朝右上即握持方向；
   * 端帽不能再大，否则两个圆会喧宾夺主，整体读成「刷新/重载」。
   *
   * 几何以 24 为基准：环外径 18、环心 (12,12)、描边 3.2、端帽半径 2.8。
   */
  const u = (v: number) => scale(size, v);
  const midR = 7.4;
  // 端帽只用来把切角磨圆，不做耳罩：大耳罩会让整体像「刷新」图标
  const capR = 1.7;
  // 隐藏上边框后，两个端点在垂直于竖直轴 ±45° 的位置
  const ends = [
    { x: 12 - midR * 0.707, y: 12 - midR * 0.707 },
    { x: 12 + midR * 0.707, y: 12 - midR * 0.707 },
  ];

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: `${size}px`,
          height: `${size}px`,
          transform: 'rotate(45deg)',
        }}
      >
        {/* 握柄：3/4 圆环 */}
        <view
          style={{
            position: 'absolute',
            left: u(3),
            top: u(3),
            width: u(18),
            height: u(18),
            borderRadius: u(9),
            borderWidth: u(3.2),
            borderColor: color,
            borderTopColor: 'transparent',
          }}
        />
        {/* 两端耳罩 */}
        {ends.map((e, i) => (
          <view
            key={`ear${i}`}
            style={{
              position: 'absolute',
              left: u(e.x - capR),
              top: u(e.y - capR),
              width: u(capR * 2),
              height: u(capR * 2),
              borderRadius: u(capR),
              backgroundColor: color,
            }}
          />
        ))}
      </view>
    </view>
  );
}

/** 键盘：圆角外框 + 3×2 按键点 + 空格条 */
export function IconKeyboard(props: IconProps) {
  const { size = 22, color = colors.text, stroke = 1.8 } = props;
  const w = sw(size, stroke);
  const dot = (l: number, t: number, key: string) => (
    <view
      key={key}
      style={{
        position: 'absolute',
        left: scale(size, l),
        top: scale(size, t),
        width: scale(size, 2.4),
        height: scale(size, 2.4),
        borderRadius: scale(size, 1.2),
        backgroundColor: color,
      }}
    />
  );

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
      {dot(6, 9.5, 'd1')}
      {dot(10.8, 9.5, 'd2')}
      {dot(15.6, 9.5, 'd3')}
      {dot(8.4, 13.4, 'd4')}
      {dot(13.2, 13.4, 'd5')}
    </view>
  );
}

/**
 * 麦克风（输入栏语音按钮）
 * 与 IconMic 的区别：这里不画底部支架，只保留话筒本体，
 * 避免 20px 下横线糊成一团。
 */
export function IconVoice(props: IconProps) {
  const { size = 22, color = colors.text, stroke = 2 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 9),
          top: scale(size, 3),
          width: scale(size, 6),
          height: scale(size, 11),
          borderRadius: scale(size, 3),
          borderWidth: w,
          borderColor: color,
        }}
      />
      {/* 下半段托架：半圆 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 5.5),
          top: scale(size, 9),
          width: scale(size, 13),
          height: scale(size, 6.5),
          borderWidth: w,
          borderTopWidth: 0,
          borderColor: color,
          borderBottomLeftRadius: scale(size, 6.5),
          borderBottomRightRadius: scale(size, 6.5),
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: scale(size, 11),
          top: scale(size, 16),
          width: w,
          height: scale(size, 4),
          backgroundColor: color,
          borderRadius: w,
        }}
      />
    </view>
  );
}

/** 照片：圆角外框 + 太阳 + 山脊 */
export function IconPhoto(props: IconProps) {
  const { size = 22, color = colors.text, stroke = 1.8 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 2.5),
          top: scale(size, 4.5),
          width: scale(size, 19),
          height: scale(size, 15),
          borderRadius: scale(size, 3),
          borderWidth: w,
          borderColor: color,
        }}
      />
      {/* 太阳 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 6.5),
          top: scale(size, 8),
          width: scale(size, 3.2),
          height: scale(size, 3.2),
          borderRadius: scale(size, 1.6),
          backgroundColor: color,
        }}
      />
      {/* 山脊：两条 45° 短线拼成折线 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 11),
          top: scale(size, 12.2),
          width: scale(size, 5.2),
          height: w,
          backgroundColor: color,
          borderRadius: w,
          transform: 'rotate(-42deg)',
          transformOrigin: 'left center',
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: scale(size, 14.6),
          top: scale(size, 8.8),
          width: scale(size, 6),
          height: w,
          backgroundColor: color,
          borderRadius: w,
          transform: 'rotate(40deg)',
          transformOrigin: 'left center',
        }}
      />
    </view>
  );
}

/** 相机：机身 + 顶部取景凸起 + 镜头圈 */
export function IconCamera(props: IconProps) {
  const { size = 22, color = colors.text, stroke = 1.8 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      {/* 顶部取景凸起 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 8.5),
          top: scale(size, 3.5),
          width: scale(size, 7),
          height: scale(size, 3),
          borderWidth: w,
          borderBottomWidth: 0,
          borderColor: color,
          borderTopLeftRadius: scale(size, 2),
          borderTopRightRadius: scale(size, 2),
        }}
      />
      {/* 机身 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 2.5),
          top: scale(size, 6),
          width: scale(size, 19),
          height: scale(size, 13.5),
          borderRadius: scale(size, 3),
          borderWidth: w,
          borderColor: color,
        }}
      />
      {/* 镜头 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 8.5),
          top: scale(size, 9),
          width: scale(size, 7),
          height: scale(size, 7),
          borderRadius: scale(size, 3.5),
          borderWidth: w,
          borderColor: color,
        }}
      />
    </view>
  );
}

/** 摄像机：机身 + 右侧三角 */
export function IconVideo(props: IconProps) {
  const { size = 22, color = colors.text, stroke = 1.8 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 2),
          top: scale(size, 5.5),
          width: scale(size, 13),
          height: scale(size, 13),
          borderRadius: scale(size, 3),
          borderWidth: w,
          borderColor: color,
        }}
      />
      {/* 右侧出带：用两条斜线围出三角形，规避 border 三角形在各端的差异 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 16),
          top: scale(size, 8.1),
          width: scale(size, 6),
          height: w,
          backgroundColor: color,
          borderRadius: w,
          transform: 'rotate(-40deg)',
          transformOrigin: 'left center',
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: scale(size, 16),
          top: scale(size, 15.9),
          width: scale(size, 6),
          height: w,
          backgroundColor: color,
          borderRadius: w,
          transform: 'rotate(40deg)',
          transformOrigin: 'left center',
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: scale(size, 21),
          top: scale(size, 11.4),
          width: w,
          height: scale(size, 1.2),
          backgroundColor: color,
          borderRadius: w,
        }}
      />
    </view>
  );
}

/** 文档：矩形 + 右上折角 */
export function IconFile(props: IconProps) {
  const { size = 22, color = colors.text, stroke = 1.8 } = props;
  const w = sw(size, stroke);

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 5),
          top: scale(size, 2.5),
          width: scale(size, 14),
          height: scale(size, 19),
          borderRadius: scale(size, 2.5),
          borderWidth: w,
          borderColor: color,
        }}
      />
      {/* 折角 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 13),
          top: scale(size, 2.6),
          width: scale(size, 5.6),
          height: scale(size, 5.6),
          borderLeftWidth: w,
          borderBottomWidth: w,
          borderColor: color,
          borderBottomLeftRadius: scale(size, 1.5),
        }}
      />
      {/* 文字行 */}
      <view
        style={{
          position: 'absolute',
          left: scale(size, 7.8),
          top: scale(size, 12.5),
          width: scale(size, 8),
          height: w,
          backgroundColor: color,
          borderRadius: w,
        }}
      />
      <view
        style={{
          position: 'absolute',
          left: scale(size, 7.8),
          top: scale(size, 16),
          width: scale(size, 5.5),
          height: w,
          backgroundColor: color,
          borderRadius: w,
        }}
      />
    </view>
  );
}

/** 播放三角（语音条左侧） */
export function IconPlay(props: IconProps) {
  const { size = 14, color = colors.text } = props;

  return (
    <view style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }}>
      <view
        style={{
          position: 'absolute',
          left: scale(size, 8),
          top: scale(size, 5),
          width: scale(size, 12),
          height: scale(size, 12),
          borderTopWidth: scale(size, 6),
          borderBottomWidth: scale(size, 6),
          borderLeftWidth: scale(size, 10),
          borderTopColor: 'transparent',
          borderBottomColor: 'transparent',
          borderLeftColor: color,
          borderTopRightRadius: scale(size, 1.5),
          borderBottomRightRadius: scale(size, 1.5),
        }}
      />
    </view>
  );
}

/** 暂停（两竖条） */
export function IconPause(props: IconProps) {
  const { size = 14, color = colors.text } = props;
  const barW = scale(size, 3.2);

  return (
    <view
      style={{
        width: `${size}px`,
        height: `${size}px`,
        position: 'relative',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <view
        style={{
          width: barW,
          height: scale(size, 10),
          backgroundColor: color,
          borderRadius: scale(size, 1),
          marginRight: scale(size, 2),
        }}
      />
      <view
        style={{
          width: barW,
          height: scale(size, 10),
          backgroundColor: color,
          borderRadius: scale(size, 1),
        }}
      />
    </view>
  );
}

/** 未使用的辅助导出，避免 halfStroke 被判为未使用 */
export const iconMetrics = { halfStroke, scale };
