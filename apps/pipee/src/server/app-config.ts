import { Config, Context, Effect, Layer } from "effect"

export interface AppConfigValue {
  readonly home: string
  readonly platform: string
  readonly skillsApiUrl: string
}

export class AppConfig extends Context.Service<AppConfig, AppConfigValue>()("pipee/server/AppConfig") {}

const Home = Config.string("HOME").pipe(Config.orElse(() => Config.string("USERPROFILE")))

const AppConfigEffect = Config.all({
  home: Home,
  platform: Config.string("PIPEE_PLATFORM").pipe(Config.withDefault(process.platform)),
  skillsApiUrl: Config.string("SKILLS_API_URL").pipe(Config.withDefault("https://skills.sh")),
})

export const AppConfigLive: Layer.Layer<AppConfig, Config.ConfigError> = Layer.effect(
  AppConfig,
  Effect.map(AppConfigEffect, AppConfig.of),
)
