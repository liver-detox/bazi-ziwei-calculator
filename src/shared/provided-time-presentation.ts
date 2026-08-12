export const PROVIDED_TIME_PRESENTATION = Object.freeze({
  apparent_solar_provided: Object.freeze({
    label: "已确认的真太阳时间（推荐）",
    assertionCode: "provided_apparent_solar",
    statement: "用户声明该日期时间已完成真太阳时校正；本系统从该输入开始进行双轨计算与审计。"
  }),
  civil_clock_provided: Object.freeze({
    label: "当地钟表时间直接排盘",
    assertionCode: "provided_civil_clock",
    statement: "本次按用户输入的当地钟表日期时间直接排盘；未进行真太阳时校正。"
  })
} as const);

export type ProvidedTimeAssertionCode = typeof PROVIDED_TIME_PRESENTATION[keyof typeof PROVIDED_TIME_PRESENTATION]["assertionCode"];
