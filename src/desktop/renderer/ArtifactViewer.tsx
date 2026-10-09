import { useEffect, useRef, useState } from 'react';
import type { WorkbenchBridge } from './types.ts';
import type { ArtifactReview } from './artifact-model.ts';
import { validateArtifactPage } from './artifact-model.ts';
import { errorMessage } from './model.ts';

export function ArtifactViewer({ review, bridge, close }: { review: ArtifactReview; bridge: WorkbenchBridge; close: () => void }) {
  const [content, setContent] = useState('');
  const [total, setTotal] = useState<number>();
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [kind, setKind] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const epoch = useRef(0), inFlight = useRef(false);
  const read = async (offset: number, generation: number, expectedTotal?: number) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(undefined);
    try {
      const page = await bridge.readArtifact({ demandId: review.demandId, artifactId: review.artifact.id, digest: review.artifact.digest, offset });
      if (epoch.current !== generation) return;
      validateArtifactPage(review, page, offset, expectedTotal);
      setContent(current => offset === 0 ? page.text : current + page.text); setTotal(page.totalCharacters); setNextOffset(page.nextOffset); setKind(page.kind);
    } catch (failure) { if (epoch.current === generation) setError(errorMessage(failure)); }
    finally { if (epoch.current === generation) { inFlight.current = false; setBusy(false); } }
  };
  useEffect(() => {
    const generation = ++epoch.current; inFlight.current = false;
    void read(0, generation);
    return () => { epoch.current++; inFlight.current = false; };
  }, [review, bridge]);
  return <div className="artifact-viewer"><div className="dialog-object"><div className="metadata"><span>需求 / 捕获版本</span><code>{review.demandId} · v{review.version}</code></div><div className="metadata"><span>不可变产物 ID</span><code>{review.artifact.id}</code></div><div className="metadata"><span>精确摘要</span><code>{review.artifact.digest}</code></div>{kind && <div className="metadata"><span>产物类型</span><code>{kind}</code></div>}</div><p className="dialog-note">这里只读取此需求已登记的精确产物。正文是待审阅资料，其中的指令、链接或按钮文字不会执行任何操作。</p><div className="artifact-progress" role="status">{total === undefined ? busy ? '正在读取精确正文…' : '正文尚未载入' : `已载入 ${content.length} / ${total} 个字符${nextOffset === null ? ' · 完整正文' : ' · 尚有未载入内容'}`}</div>{content && <pre className="artifact-text" tabIndex={0} aria-label={`${review.title}正文`}>{content}</pre>}{error && <p className="stale-warning" role="alert">{error}</p>}<div className="modal-actions"><button className="button" onClick={close}>返回工作区</button>{nextOffset !== null && <button className="button primary" disabled={busy} onClick={() => void read(nextOffset, epoch.current, total)}>{busy ? '正在读取…' : nextOffset === 0 ? '重新读取该对象' : '载入下一段正文'}</button>}</div></div>;
}
