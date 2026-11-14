// Search provider adapter. Any web search API that returns ordinary result
// links can sit behind this; the pipeline never depends on one vendor.
export type SearchResult = {
  url: string;
  title: string | null;
  snippet: string | null;
  /** When the provider says the page was published, if it says so. */
  publishedAt: Date | null;
};

export type SearchResponse = { results: SearchResult[]; requestId: string | null };

export interface SearchProvider {
  readonly name: string;
  /** Estimated list price of one query in USD, recorded as usage before the cap is checked again. */
  readonly costPerQueryUsd: number;
  search(query: string, options: { count: number; country?: string; signal?: AbortSignal }): Promise<SearchResponse>;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
    message: string,
  ) {
    super(`${provider}: ${message}`);
  }
}
