import { Option, Schema } from "effect"
import {
  ChromeStatusProjection,
  JsonValue,
  WeixinStatusProjection,
  type ExtensionStatusContribution,
} from "@/api/contract"
import { LoopStatusProjection } from "@/features/session/session-automation"

export const decodeChromeStatusProjection = Schema.decodeUnknownOption(ChromeStatusProjection)
export const decodeWeixinStatusProjection = Schema.decodeUnknownOption(WeixinStatusProjection)
export const decodeLoopStatusProjection = Schema.decodeUnknownOption(LoopStatusProjection)
export const decodeExtensionStructuredStatus = Schema.decodeUnknownOption(JsonValue)
const decodeStructuredStatusDiscriminator = Schema.decodeUnknownOption(
  Schema.Struct({
    kind: Schema.NonEmptyString,
    version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
)

export const extensionStructuredStatusOrUndefined = (
  value: unknown,
): { readonly kind: string; readonly version: number; readonly value: JsonValue } | undefined => {
  const json = Option.getOrUndefined(decodeExtensionStructuredStatus(value))
  const discriminator = Option.getOrUndefined(decodeStructuredStatusDiscriminator(value))
  return json === undefined || discriminator === undefined ? undefined : { ...discriminator, value: json }
}

export function getChromeStatusProjection(
  statuses: ReadonlyArray<ExtensionStatusContribution>,
): ChromeStatusProjection | undefined {
  for (const item of statuses) {
    if (item._tag !== "Structured") continue
    const status = chromeStatusOrUndefined(item.value)
    if (status !== undefined) return status
  }
  return undefined
}

export function getWeixinStatusProjection(
  statuses: ReadonlyArray<ExtensionStatusContribution>,
): WeixinStatusProjection | undefined {
  for (const item of statuses) {
    if (item._tag !== "Structured") continue
    const status = Option.getOrUndefined(decodeWeixinStatusProjection(item.value))
    if (status !== undefined) return status
  }
  return undefined
}

export function getLoopStatusProjection(
  statuses: ReadonlyArray<ExtensionStatusContribution>,
): LoopStatusProjection | undefined {
  for (const item of statuses) {
    if (item._tag !== "Structured") continue
    const status = Option.getOrUndefined(decodeLoopStatusProjection(item.value))
    if (status !== undefined) return status
  }
  return undefined
}

export function sameWeixinStatusProjection(left: WeixinStatusProjection, right: WeixinStatusProjection): boolean {
  if (left.bindings.length !== right.bindings.length) return false
  const rightBySession = new Map(right.bindings.map((binding) => [binding.sessionId, binding]))
  return left.bindings.every((binding) => {
    const candidate = rightBySession.get(binding.sessionId)
    return (
      candidate !== undefined && candidate.accountId === binding.accountId && candidate.connected === binding.connected
    )
  })
}

export const chromeStatusOrUndefined = (value: unknown): ChromeStatusProjection | undefined =>
  Option.getOrUndefined(decodeChromeStatusProjection(value))
