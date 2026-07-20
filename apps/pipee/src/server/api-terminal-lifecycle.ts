type ApiTerminalDispose = () => Promise<void>

const lifecycleKey = Symbol.for("pipee.api-terminal.dispose")
const lifecycleGlobal = globalThis as typeof globalThis & {
  [key: symbol]: ApiTerminalDispose | undefined
}

export const registerApiTerminalDispose = (dispose: ApiTerminalDispose): (() => void) => {
  lifecycleGlobal[lifecycleKey] = dispose
  return () => {
    if (lifecycleGlobal[lifecycleKey] === dispose) delete lifecycleGlobal[lifecycleKey]
  }
}

export const disposeRegisteredApiTerminal = (): Promise<void> => lifecycleGlobal[lifecycleKey]?.() ?? Promise.resolve()
