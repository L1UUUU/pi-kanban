import type { ArtifactRef } from '../../domain/types.ts';
import type { ArtifactPage } from './types.ts';
export interface ArtifactReview { demandId: string; version: number; title: string; artifact: ArtifactRef }
/** An immutable artifact page must never silently substitute another demand's object or range. */
export function validateArtifactPage(review: ArtifactReview, page: ArtifactPage, offset: number, total?: number): void {
  if (page.id !== review.artifact.id || page.digest !== review.artifact.digest || page.offset !== offset) throw new Error('产物身份或分页范围已变化，拒绝显示替代对象。');
  if (typeof page.text !== 'string' || page.text.length > 16_384 || !Number.isSafeInteger(page.totalCharacters) || page.totalCharacters < 0 || (total !== undefined && page.totalCharacters !== total)) throw new Error('产物分页不完整，请重新读取精确对象。');
  const end = offset + page.text.length;
  if (end > page.totalCharacters || (page.nextOffset === null ? end !== page.totalCharacters : !Number.isSafeInteger(page.nextOffset) || page.nextOffset !== end || page.nextOffset <= offset || page.nextOffset >= page.totalCharacters)) throw new Error('产物分页范围无效，不能确认正文完整。');
}
