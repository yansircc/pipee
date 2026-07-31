const record = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;

const jsonPayload = (content) => {
  const text = Array.isArray(content)
    ? content
        .filter((part) => record(part)?.type === "text" && typeof record(part)?.text === "string")
        .map((part) => record(part).text)
        .join("\n")
    : "";
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Pi session JSONL is the acceptance truth. These names deliberately match
 * Pi's persisted tool-call envelope (`toolName` / `input`), not provider API
 * field names or a second test-only event model.
 */
export const readToolLedger = (events) => {
  const results = new Map();
  for (const event of events) {
    const message = record(event)?.message;
    if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    results.set(message.toolCallId, {
      isError: message.isError === true,
      text: Array.isArray(message.content)
        ? message.content
            .filter((part) => record(part)?.type === "text")
            .map((part) => String(record(part).text ?? ""))
            .join("\n")
        : "",
      payload: jsonPayload(message.content),
    });
  }
  const calls = [];
  for (const [index, event] of events.entries()) {
    const message = record(event)?.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const content of message.content) {
      const call = record(content);
      if (call?.type !== "toolCall" || typeof call.toolCallId !== "string") continue;
      calls.push({
        index,
        id: call.toolCallId,
        name: typeof call.toolName === "string" ? call.toolName : "",
        input: record(call.input),
        result: results.get(call.toolCallId) ?? null,
      });
    }
  }
  return calls;
};

export const recordValue = record;
