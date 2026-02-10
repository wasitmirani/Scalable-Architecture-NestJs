import { Repository, SelectQueryBuilder, ObjectLiteral } from 'typeorm';
import { APP_CONSTANTS } from '../constants/app.constants';

export interface PaginationOptions {
    page?: number;
    limit?: number;
    /**
     * Base URL to build pagination links. Can be a relative path like '/items'
     * or a full URL. If not provided, `links` will be omitted from the result.
     */
    baseUrl?: string;
    /**
     * Additional query parameters to keep in generated links (e.g. filters, sorts).
     * Values will be URL-encoded.
     */
    query?: Record<string, string | number | boolean>;
}

export interface PaginationLinks {
    first: string;
    last: string;
    prev: string | null;
    next: string | null;
}

export interface PaginationResult<T> {
    message: string;
    results: T[];
    total: number;
    page: number;
    lastPage: number;
    prevPage: number | null;
    nextPage: number | null;
    links?: PaginationLinks;
}

function buildQuery(params: Record<string, string | number | boolean>): string {
    return Object.keys(params)
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
        .join('&');
}

export async function paginate<T extends ObjectLiteral>(
    repository: Repository<T> | SelectQueryBuilder<T>,
    options: PaginationOptions = {},
    message: string = ''
): Promise<PaginationResult<T>> {
    const page = options.page && options.page > 0 ? options.page : 1;
    const limit = options.limit && options.limit > 0 && options.limit <= APP_CONSTANTS.MAX_PAGE_LIMIT ? options.limit : APP_CONSTANTS.DEFAULT_PAGE_LIMIT;
    const skip = (page - 1) * limit;

    let [results, total]: [T[], number] = [[], 0];

    if (repository instanceof Repository) {
        [results, total] = await repository.findAndCount({
            skip,
            take: limit,
        });
    } else {
        [results, total] = await repository.skip(skip).take(limit).getManyAndCount();
    }

    const lastPage = Math.max(1, Math.ceil(total / limit));
    const prevPage = page > 1 ? page - 1 : null;
    const nextPage = page < lastPage ? page + 1 : null;

    let links: PaginationLinks | undefined = undefined;
    if (options.baseUrl) {
        const base = options.baseUrl;
        const extraQuery = options.query ? { ...options.query } : {};
        const build = (p: number) => {
            const params = { ...extraQuery, page: p, limit };
            const qs = buildQuery(params);
            const sep = base.includes('?') ? '&' : '?';
            return `${base}${qs ? sep + qs : ''}`;
        };

        links = {
            first: build(1),
            last: build(lastPage),
            prev: prevPage ? build(prevPage) : null,
            next: nextPage ? build(nextPage) : null,
        };
    }

    return {
        message: message || 'Data fetched successfully',
        results,
        total,
        page,
        lastPage,
        prevPage,
        nextPage,
        links,
    };
}
