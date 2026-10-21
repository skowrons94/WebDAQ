/**
 * One way to name a board and its channels on every page: "V1725S 0" and
 * "V1725S 0 · ch 3" — the model as the server reports it, then the board's
 * number. Pages used to say "V1725S #0", "Board 1 - Channel 14",
 * "V1725S (ID: 0)" or "Board 0 / DPP-PHA" for the same thing.
 */

type BoardLike = { id?: string | number | null; name?: string | null; model_name?: string | null }

/** "V1725S 0"; "Board 0" when the model is not known. */
export function boardLabel(board: BoardLike | null | undefined, fallbackId?: string | number): string {
  const id = board?.id ?? fallbackId ?? '?'
  const model = (board?.name || board?.model_name || '').trim()
  return model ? `${model} ${id}` : `Board ${id}`
}

/** "V1725S 0 · ch 3" (channels counted from 0, as on the boards). */
export function channelLabel(board: BoardLike | null | undefined, channel: string | number, fallbackId?: string | number): string {
  return `${boardLabel(board, fallbackId)} · ch ${channel}`
}
