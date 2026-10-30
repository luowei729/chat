/**
 * ============================================================
 * 布局探针（临时调试组件）
 * ============================================================
 * 目的：一次实验确定 Lynx 在当前设备上到底认可哪些布局方式。
 *
 * 每个探针用不同的尺寸策略，颜色鲜亮、互不重叠：
 *   P1 绝对定位 + 固定 px      绿 #00FF00   —— 最"硬"的定位方式
 *   P2 文档流 + 固定 px 高     黄 #FFD400   —— 基础宽度撑满
 *   P3 height:100%             青 #00E5FF   —— 百分比高度（重点验证）
 *   P4 flex:1                  橙 #FF7A00   —— 弹性填充（重点验证）
 *   P5 纯文字                  白 #FFFFFF   —— 文字管线是否正常
 *
 * 判读方法（看红条下方的实际画面）：
 *   只有绿块          → 绝对定位可用，流式布局整体失效
 *   绿+黄             → 基础流式布局正常，问题在百分比/flex
 *   绿+黄+青+橙       → 布局全部正常，问题在具体页面的子组件
 *   全都没有          → 根容器尺寸为 0，vh 不被支持
 * ============================================================
 */

const root: Record<string, unknown> = {
  // 亮蓝底：与近黑背景形成强对比，一眼判断根容器是否有尺寸
  backgroundColor: '#0B2A55',
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
};

export function Probe() {
  return (
    <view style={root}>
      {/* P1 绝对定位固定块 */}
      <view
        style={{
          position: 'absolute',
          left: '20px',
          top: '20px',
          width: '120px',
          height: '120px',
          backgroundColor: '#00FF00',
        }}
      />

      {/* P2 流式固定高度 */}
      <view
        style={{
          width: '100%',
          height: '60px',
          marginTop: '160px',
          backgroundColor: '#FFD400',
        }}
      />

      {/* P3 百分比高度 */}
      <view
        style={{
          width: '100%',
          height: '20%',
          backgroundColor: '#00E5FF',
        }}
      />

      {/* P4 flex:1 */}
      <view
        style={{
          width: '100%',
          flex: 1,
          backgroundColor: '#FF7A00',
        }}
      />

      {/* P5 文字 */}
      <view style={{ width: '100%', height: '40px', display: 'flex', alignItems: 'center' }}>
        <text style={{ color: '#FFFFFF', fontSize: '20px' }}>PROBE TEXT OK</text>
      </view>
    </view>
  );
}
