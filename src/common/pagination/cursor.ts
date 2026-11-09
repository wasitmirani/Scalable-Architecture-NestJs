import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { APP_CONSTANTS } from '../constants/app.constants';

/**
 * Keyset pagination over UUIDv7 primary keys (time-ordered), newest first.
 * The cursor is the id of the last item of the previous page.
 */
export class CursorQueryDto {
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(APP_CONSTANTS.MAX_PAGE_LIMIT)
  limit?: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export async function paginateByCursor<
  T extends ObjectLiteral & { id: string },
>(
  qb: SelectQueryBuilder<T>,
  { cursor, limit = APP_CONSTANTS.DEFAULT_PAGE_LIMIT }: CursorQueryDto,
): Promise<CursorPage<T>> {
  const alias = qb.alias;
  if (cursor) qb.andWhere(`${alias}.id < :cursor`, { cursor });
  const rows = await qb
    .orderBy(`${alias}.id`, 'DESC')
    .take(limit + 1)
    .getMany();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}
