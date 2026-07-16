import type { InputCall, PageCall } from "../protocol/schema.js";

const MAX_TEXT = 30_000;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const rows = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value) ? value.map(record) : [];

const scalar = (value: unknown, fallback = ""): string => {
  if (value === undefined || value === null) return fallback;
  return typeof value === "string" ? value : (JSON.stringify(value) ?? fallback);
};

const compact = (value: unknown, max = 160): string => {
  const text = scalar(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const truncate = (text: string): string =>
  text.length <= MAX_TEXT
    ? text
    : `${text.slice(0, MAX_TEXT)}\n\n[truncated ${text.length - MAX_TEXT} characters]`;

export const json = (value: unknown): string => JSON.stringify(value, null, 2) ?? "null";

const formatSnapshot = (value: unknown): string => {
  const snapshot = record(value);
  if (snapshot.mode === "full") return truncate(json(value));
  const mode = scalar(snapshot.mode);
  const lines = [
    `# Chrome snapshot${mode ? ` (${mode})` : ""}`,
    scalar(snapshot.title, "(untitled)"),
    scalar(snapshot.url),
  ].filter(Boolean);
  const actions = rows(snapshot.actions);
  if (actions.length) {
    lines.push("\n## Actions");
    for (const action of actions) {
      const state = record(action.state);
      const stateText = [
        state.checked === undefined ? "" : `checked=${scalar(state.checked)}`,
        state.focused === true ? "focused" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const verbs = Array.isArray(action.verbs)
        ? action.verbs
            .map((verb) => scalar(verb))
            .filter(Boolean)
            .join(", ")
        : "";
      lines.push(
        `- @${scalar(action.id, "?")} ${scalar(action.role, "element")} ${JSON.stringify(compact(action.name, 240))}${stateText ? ` ${stateText}` : ""} [${verbs}]`,
      );
    }
  }
  const contexts = rows(snapshot.contexts);
  if (contexts.length) {
    lines.push("\n## Contexts");
    for (const context of contexts) {
      lines.push(
        `- @${scalar(context.id, "?")} ${scalar(context.role, "region")} ${JSON.stringify(compact(context.name, 240))} actions=${scalar(context.shownActionCount, "0")}/${scalar(context.actionCount, "?")}`,
      );
    }
  }
  const frontiers = rows(snapshot.frontiers);
  if (frontiers.length) {
    lines.push("\n## More context");
    for (const frontier of frontiers) {
      lines.push(
        `- @${scalar(frontier.id, "?")} ${JSON.stringify(compact(frontier.name, 240))} omitted=${scalar(frontier.omittedCount, "?")} [expand with chrome_snapshot]`,
      );
    }
  }
  if (mode === "text") {
    const blocks = rows(snapshot.contentBlocks);
    for (const block of blocks) {
      const kind = scalar(block.kind);
      const uid = scalar(block.uid, "?");
      const text = compact(block.text, 1_200);
      const links = rows(block.links);
      const primaryLink = links[0];
      const href = kind === "heading" || kind === "link" ? scalar(primaryLink?.href) : "";
      const linkedText = href ? `[${text}](${href})` : text;
      if (kind === "heading") {
        const level = Math.min(6, Math.max(1, Number(block.level) || 2));
        lines.push(`\n${"#".repeat(level)} ${uid} ${linkedText}`);
      } else if (kind === "listItem") {
        lines.push(`- ${uid} ${linkedText}`);
      } else {
        lines.push(`\n${uid} ${linkedText}`);
      }
      for (const link of links.slice(href ? 1 : 0, 8)) {
        lines.push(
          `  link ${scalar(link.uid, "?")} ${compact(link.text, 240)} ${scalar(link.href)}`,
        );
      }
      const context = record(block.context);
      const contextLabel = compact(context.label, 240);
      if (contextLabel && contextLabel !== text) {
        lines.push(`  context ${scalar(context.uid, "?")} ${contextLabel}`);
      }
    }
    if (snapshot.textTruncated === true) lines.push("\n[content truncated]");
    return truncate(lines.join("\n"));
  }
  const summary = record(snapshot.summary);
  const focused = record(summary.focused);
  const focusedUid = scalar(focused.uid);
  if (focusedUid) lines.push(`focused: ${focusedUid} ${compact(focused.label)}`);
  const matches = rows(snapshot.matches);
  if (matches.length) {
    lines.push("\n## Matches");
    for (const item of matches.slice(0, 16)) {
      lines.push(
        `- ${scalar(item.uid, "?")} ${scalar(item.role ?? item.kind ?? item.tag, "item")} ${compact(item.label ?? item.text)}`,
      );
    }
  }
  const snippets = rows(snapshot.textSnippets);
  if (snippets.length) {
    lines.push("\n## Text");
    for (const item of snippets.slice(0, 40))
      lines.push(`- ${scalar(item.uid, "?")} ${compact(item.text, 240)}`);
  }
  return truncate(lines.join("\n"));
};

export const formatPageResult = (call: PageCall, value: unknown): string => {
  const operation = call.operation;
  if (operation.kind === "snapshot") return formatSnapshot(value);
  if (operation.kind === "read") {
    const result = record(value);
    const coverage = record(result.coverage);
    const lines = [
      `# Chrome read (${scalar(result.view, "content")})`,
      scalar(result.title, "(untitled)"),
      scalar(result.url),
      `blocks: ${scalar(coverage.returnedBlocks, "0")}/${scalar(coverage.totalBlocks, "?")}, characters: ${scalar(coverage.returnedCharacters, "0")}`,
    ];
    for (const block of rows(result.blocks)) {
      const kind = scalar(block.kind);
      const body = compact(block.text, 1_200);
      if (kind === "heading") {
        const level = Math.min(6, Math.max(1, Number(block.level) || 2));
        lines.push(`\n${"#".repeat(level)} ${body}`);
      } else if (kind === "listItem") {
        lines.push(`- ${body}`);
      } else {
        lines.push(`\n${body}`);
      }
      for (const link of rows(block.links).slice(0, 8)) {
        lines.push(`  link ${compact(link.text, 240)} ${scalar(link.href)}`);
      }
    }
    for (const frontier of rows(result.frontiers)) {
      lines.push(
        `\nmore: @${scalar(frontier.id, "?")} omitted=${scalar(frontier.omittedCount, "?")} [expand with chrome_read]`,
      );
    }
    return truncate(lines.filter(Boolean).join("\n"));
  }
  if (operation.kind === "evaluate") {
    return typeof value === "string" ? truncate(value) : truncate(json(value));
  }
  if (operation.kind === "navigate") {
    const result = record(value);
    const nestedTab = record(result.tab);
    const tab = Object.keys(nestedTab).length ? nestedTab : result;
    const actualUrl = scalar(tab.url, "(unknown URL)");
    const lines = [`Navigated to ${actualUrl}`];
    if (actualUrl !== operation.url) lines.push(`requested: ${operation.url}`);
    const title = compact(tab.title);
    if (title) lines.push(`title: ${title}`);
    const status = scalar(tab.status);
    if (status) lines.push(`status: ${status}`);
    const snapshot = record(result.snapshot);
    return Object.keys(snapshot).length
      ? `${lines.join("\n")}\n\n${formatSnapshot(snapshot)}`
      : lines.join("\n");
  }
  if (operation.kind === "wait") {
    const result = record(value);
    const observation = record(result.observation);
    const lines = [
      result.satisfied === true ? "Wait condition satisfied" : "Wait condition not satisfied",
      `${operation.condition.by}: ${operation.condition.value}`,
      `elapsed: ${scalar(result.elapsedMs, "?")}ms`,
      `url: ${scalar(observation.url, "(unknown)")}`,
      `title: ${compact(observation.title) || "(untitled)"}`,
      `readyState: ${scalar(observation.readyState, "unknown")}`,
      `body text: ${scalar(observation.bodyTextLength, "?")} characters`,
    ];
    if (observation.matchCount !== undefined) {
      lines.push(`selector matches: ${scalar(observation.matchCount)}`);
    }
    return lines.join("\n");
  }
  if (operation.kind === "console" || operation.kind.startsWith("network"))
    return truncate(json(value));
  if (operation.kind === "inspect") return truncate(json(value));
  return truncate(json(value));
};

export const formatInputResult = (call: InputCall, value: unknown): string => {
  const result = record(value);
  const action = record(result.action);
  const verification = record(result.verification);
  const operation = call.operation;
  const base = `${operation.kind} completed`;
  const effects = Array.isArray(action.observedChanges)
    ? action.observedChanges.map((effect) => scalar(effect)).filter(Boolean)
    : [];
  const text = effects.length ? `${base}: ${effects.join(", ")}` : base;
  if (verification.status === "unavailable") {
    return `${text}\nPost-action snapshot unavailable; the action result was preserved: ${compact(verification.reason, 1_000)}`;
  }
  const snapshot = record(verification.snapshot);
  return Object.keys(snapshot).length ? `${text}\n\n${formatSnapshot(snapshot)}` : text;
};
