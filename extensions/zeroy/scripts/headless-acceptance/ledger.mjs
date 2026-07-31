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
 * Pi session JSONL is the acceptance truth. Pi persists tool calls in either
 * host-normalized (`toolCallId` / `toolName` / `input`) or provider-native
 * (`id` / `name` / `arguments`) blocks. Both describe one Pi tool call; the
 * ledger normalizes the block at the read boundary without storing another
 * event model.
 */
const toolCall = (value) => {
  const call = record(value);
  if (call?.type !== "toolCall") return null;
  const id = typeof call.toolCallId === "string" ? call.toolCallId : call.id;
  const name = typeof call.toolName === "string" ? call.toolName : call.name;
  const input = record(call.input) ?? record(call.arguments);
  return typeof id === "string" && typeof name === "string" && input !== null
    ? { id, name, input }
    : null;
};

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
      const call = toolCall(content);
      if (call === null) continue;
      calls.push({
        index,
        ...call,
        result: results.get(call.id) ?? null,
      });
    }
  }
  return calls;
};

export const recordValue = record;
