export interface EffectScopeLifecycle {
  mount: (owner: string) => number
  unmount: (epoch: number) => void
  current: (owner: string) => number | null
  owns: (epoch: number, owner: string) => boolean
}

export const makeEffectScopeLifecycle = (): EffectScopeLifecycle => {
  let nextEpoch = 0
  let activeEpoch: number | null = null
  let activeOwner: string | null = null

  return {
    mount: (owner) => {
      nextEpoch += 1
      activeEpoch = nextEpoch
      activeOwner = owner
      return activeEpoch
    },
    unmount: (epoch) => {
      if (activeEpoch !== epoch) return
      activeEpoch = null
      activeOwner = null
    },
    current: (owner) => (activeOwner === owner ? activeEpoch : null),
    owns: (epoch, owner) => activeEpoch === epoch && activeOwner === owner,
  }
}
