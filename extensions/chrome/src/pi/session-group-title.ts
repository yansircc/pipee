const normalize = (value: string): string => value.replaceAll(/\s+/g, " ").trim();

const truncate = (value: string, limit: number): string => {
  const points = Array.from(value);
  return points.length <= limit ? value : `${points.slice(0, limit - 1).join("")}…`;
};

const firstUserText = (entries: ReadonlyArray<unknown>): string | undefined => {
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("type" in entry) ||
      entry.type !== "message"
    )
      continue;
    if (!("message" in entry) || typeof entry.message !== "object" || entry.message === null)
      continue;
    const message = entry.message;
    if (!("role" in message) || message.role !== "user" || !("content" in message)) continue;
    if (typeof message.content === "string") {
      const text = normalize(message.content);
      if (text) return text;
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    const text = normalize(
      message.content
        .flatMap((part) =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join(" "),
    );
    if (text) return text;
  }
  return undefined;
};

export const projectSessionGroupTitle = (
  sessionId: string,
  sessionName: string | undefined,
  branchEntries: ReadonlyArray<unknown>,
): string => {
  const name = sessionName === undefined ? "" : normalize(sessionName);
  const subject = name || firstUserText(branchEntries) || sessionId.slice(0, 8);
  return `Pi · ${truncate(subject, 70)}`;
};
