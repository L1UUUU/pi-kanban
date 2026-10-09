import type { CSSProperties } from 'react';
export type IconName = 'plus' | 'folder' | 'chevron' | 'arrow' | 'spark' | 'inbox' | 'bulb' | 'search' | 'settings' | 'check' | 'close' | 'pause' | 'play' | 'stop' | 'file' | 'terminal' | 'shield' | 'book' | 'branch' | 'clock' | 'alert' | 'panel' | 'refresh' | 'send' | 'layers' | 'command' | 'link';
const paths: Record<IconName, string> = {
  plus:'M12 5v14M5 12h14', folder:'M3 7V5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  chevron:'m9 5 7 7-7 7', arrow:'M5 12h14m-5-5 5 5-5 5', spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  inbox:'M4 4h16l2 12v4H2v-4L4 4Zm-2 12h6l2 3h4l2-3h6', bulb:'M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0l-1 3H9l-1-3Z',
  search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z', settings:'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM10 2h4l1 3 3 1 3 3-1 3 1 3-3 3-3 1-1 3h-4l-1-3-3-1-3-3 1-3-1-3 3-3 3-1 1-3Z',
  check:'m5 12 4 4L19 6', close:'m6 6 12 12M6 18 18 6', pause:'M8 5v14M16 5v14', play:'m7 4 13 8-13 8V4Z', stop:'M5 5h14v14H5Z',
  file:'M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 12h8M8 16h6', terminal:'m5 7 4 5-4 5m7 0h7', shield:'m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Zm-4 10 3 3 5-6',
  book:'M12 5v16M3 3c4 0 6 0 9 2 3-2 5-2 9-2v16c-4 0-6 0-9 2-3-2-5-2-9-2V3Z', branch:'M6 6v12m12-12v3a4 4 0 0 1-4 4h-4a4 4 0 0 0-4 4M8 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm12 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM8 20a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  clock:'M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z', alert:'m12 3 10 18H2L12 3Zm0 6v5m0 3v1', panel:'M3 3h18v18H3Zm12 0v18', refresh:'M20 8a8 8 0 0 0-14-3L3 8m0-6v6h6M4 16a8 8 0 0 0 14 3l3-3m0 6v-6h-6',
  send:'m12 4 7 7m-7-7-7 7m7-7v16', layers:'m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5', command:'M9 9V5a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V9Z', link:'m10 14 4-4m-5 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2-2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
};
export function Icon({ name, size = 18, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} style={style}><path d={paths[name]} /></svg>;
}
