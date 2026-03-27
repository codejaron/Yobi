export interface ConsoleChatHistoryPage<TItem> {
  items: TItem[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ConsoleChatHistoryState<TItem> extends ConsoleChatHistoryPage<TItem> {
  loadError: string | null;
}

export function createConsoleChatHistoryState<TItem>(
  input?: Partial<ConsoleChatHistoryState<TItem>>
): ConsoleChatHistoryState<TItem> {
  return {
    items: input?.items ?? [],
    hasMore: input?.hasMore ?? false,
    nextCursor: input?.nextCursor ?? null,
    loadError: input?.loadError ?? null
  };
}

export function replaceConsoleChatHistoryPage<TItem>(
  page: ConsoleChatHistoryPage<TItem>
): ConsoleChatHistoryState<TItem> {
  return createConsoleChatHistoryState({
    items: page.items,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    loadError: null
  });
}

export function prependConsoleChatHistoryPage<TItem extends { id: string }>(
  current: ConsoleChatHistoryState<TItem>,
  page: ConsoleChatHistoryPage<TItem>
): ConsoleChatHistoryState<TItem> {
  const existingIds = new Set(current.items.map((item) => item.id));
  const olderItems = page.items.filter((item) => !existingIds.has(item.id));

  return createConsoleChatHistoryState({
    items: [...olderItems, ...current.items],
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    loadError: null
  });
}

export function applyConsoleChatHistoryLoadError<TItem>(
  current: ConsoleChatHistoryState<TItem>,
  message: string
): ConsoleChatHistoryState<TItem> {
  return createConsoleChatHistoryState({
    ...current,
    loadError: message
  });
}

export function resetConsoleChatHistoryState<TItem>(): ConsoleChatHistoryState<TItem> {
  return createConsoleChatHistoryState();
}
