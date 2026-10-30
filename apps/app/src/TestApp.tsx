/**
 * ============================================================
 * 诊断型测试组件（一次性定位黑屏根因）
 * ============================================================
 * 同一屏并列 4 种高度声明方式，看哪几块能显示即可反推布局行为：
 *   1 红色 height:120 固定像素  -> 引擎基本渲染能力
 *   2 绿色 flex:1     弹性撑满  -> flex 布局是否生效
 *   3 黄色 height:100% 百分比   -> 百分比是否塌陷（核心疑点）
 *   4 紫色 无高度     内容自适应 -> 默认行为
 *
 * 判定表：
 *   全黑              -> 引擎/宿主问题，不是布局问题
 *   仅 1、4 可见      -> 百分比高度塌陷 = 业务代码 height:100% 就是真因
 *   全部可见           -> 布局没问题，黑屏来自业务逻辑/路由
 * ============================================================
 */
export function TestApp() {
  return (
    <view style={{ display: 'flex', flexDirection: 'column', flex: 1, backgroundColor: '#070B14' }}>
      <view style={{ height: 120, backgroundColor: '#D32F2F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <text style={{ color: '#FFFFFF', fontSize: 26, fontWeight: '700' }}>1 FIXED-120</text>
      </view>

      <view style={{ flex: 1, backgroundColor: '#2E7D32', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <text style={{ color: '#FFFFFF', fontSize: 26, fontWeight: '700' }}>2 FLEX-1</text>
      </view>

      <view style={{ height: '100%', backgroundColor: '#F9A825', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <text style={{ color: '#000000', fontSize: 26, fontWeight: '700' }}>3 PERCENT-100</text>
      </view>

      <view style={{ backgroundColor: '#6A1B9A', paddingTop: 20, paddingBottom: 20, display: 'flex', alignItems: 'center' }}>
        <text style={{ color: '#FFFFFF', fontSize: 26, fontWeight: '700' }}>4 AUTO</text>
        <text style={{ color: '#E0E0E0', fontSize: 13, marginTop: 6 }}>中文测试 · Lynx</text>
      </view>
    </view>
  );
}
