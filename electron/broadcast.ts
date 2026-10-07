// Streaming broadcast pacing.
//
// Every broadcast clones the whole application state and transfers it to the renderer, and that
// state includes attachment payloads, so a long answer is not worth refreshing twelve times a
// second. Short answers stay smooth; once the streaming text grows past the threshold the cadence
// drops, and the completion path still flushes immediately.
export const STREAM_BROADCAST_MS = 80;
export const LONG_STREAM_BROADCAST_MS = 500;
export const LONG_STREAM_CHARS = 2_000;

export function broadcastDelay(streamingChars = 0) {
  return streamingChars > LONG_STREAM_CHARS ? LONG_STREAM_BROADCAST_MS : STREAM_BROADCAST_MS;
}
