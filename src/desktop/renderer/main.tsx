import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : '未知界面错误' }; }
  render() {
    if (this.state.error) return <div className="boot"><div className="boot-card"><h1>工作区暂时无法显示</h1><p>{this.state.error}</p><p>请重新打开窗口以读取最新记录。此界面错误不会授权或重新启动执行。</p></div></div>;
    return this.props.children;
  }
}
function ProductionApp() {
  if (!window.workbench) throw new Error('未发现受信任的本地 Host 连接。请从桌面应用启动；浏览器预览不能运行真实需求。');
  return <App bridge={window.workbench} />;
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing renderer root.');
createRoot(root).render(<Boundary><ProductionApp /></Boundary>);
