export const PROVIDED_TIME_PRESENTATION = Object.freeze({
  apparent_solar_provided: Object.freeze({
    label: "真太阳时间",
    assertionCode: "provided_apparent_solar",
    statement: "按你提供的真太阳日期和时间直接计算，不再校正。"
  }),
  civil_clock_provided: Object.freeze({
    label: "当地钟表时间",
    assertionCode: "provided_civil_clock",
    statement: "按你输入的当地钟表日期和时间直接计算，不做真太阳时校正。"
  })
} as const);

export type ProvidedTimeAssertionCode = typeof PROVIDED_TIME_PRESENTATION[keyof typeof PROVIDED_TIME_PRESENTATION]["assertionCode"];
