import { LoaderCircle, Sparkles, X } from "lucide-react";
import type { FormEvent } from "react";

import { PROVIDED_TIME_PRESENTATION } from "../shared/provided-time-presentation.js";
import {
  shouldShowLateZiChoice,
  shouldShowLeapMonthChoice,
  type ProvidedTimeFormState
} from "./provided-time-form-model.js";

export interface ProvidedTimeFormProps {
  form: ProvidedTimeFormState;
  setForm: (next: ProvidedTimeFormState) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  busy: boolean;
  errors?: Readonly<Record<string, string>>;
}

const SOURCE_OPTIONS = [
  ["unknown", "暂不说明"],
  ["birth_certificate", "出生证明"],
  ["hospital_record", "医院记录"],
  ["family_memory", "家人记忆"],
  ["existing_chart", "既有命盘"],
  ["external_true_solar_tool", "外部真太阳时工具"]
] as const;

function errorProps(errors: Readonly<Record<string, string>>, key: string, inputId: string) {
  return errors[key] === undefined
    ? {}
    : { "aria-invalid": true as const, "aria-describedby": `${inputId}-error` };
}

function FieldError({ errors, name, inputId }: {
  errors: Readonly<Record<string, string>>;
  name: string;
  inputId: string;
}) {
  const message = errors[name];
  return message === undefined
    ? null
    : <span className="field-error" id={`${inputId}-error`} role="alert">{message}</span>;
}

export function ProvidedTimeForm({
  form,
  setForm,
  onSubmit,
  onCancel,
  busy,
  errors = {}
}: ProvidedTimeFormProps) {
  const patch = <K extends keyof ProvidedTimeFormState>(key: K, value: ProvidedTimeFormState[K]) => {
    setForm({ ...form, [key]: value });
  };
  const basisPresentation = form.timeBasis === ""
    ? undefined
    : PROVIDED_TIME_PRESENTATION[form.timeBasis];

  return (
    <form className="birth-form provided-time-form" onSubmit={onSubmit} noValidate>
      <div className="form-heading">
        <div>
          <p className="eyebrow">极简入口 · 给定时间</p>
          <h2>输入时间，直接开始双轨排盘</h2>
          <p>建议先在外部确认真太阳日期时间；本系统不会再次校正。</p>
        </div>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="关闭"><X size={19} /></button>
      </div>

      <div className="minimal-entry-grid">
        <fieldset className="gender-fieldset">
          <legend>性别</legend>
          <div className="radio-pills">
            {(["男", "女"] as const).map((value, index) => (
              <label key={value} className={form.gender === value ? "selected" : ""}>
                <input
                  type="radio"
                  name="gender"
                  value={value}
                  checked={form.gender === value}
                  required={index === 0}
                  onChange={() => patch("gender", value)}
                  {...errorProps(errors, "gender", "gender")}
                />
                <span>{value}</span>
              </label>
            ))}
          </div>
          <FieldError errors={errors} name="gender" inputId="gender" />
        </fieldset>

        <div className="core-time-fields">
          <div className="form-field">
            <label htmlFor="birth-date">出生日期</label>
            <input
              id="birth-date"
              type="date"
              required
              min="1900-01-01"
              max="2099-12-31"
              value={form.date}
              onChange={(event) => patch("date", event.target.value)}
              {...errorProps(errors, "date", "birth-date")}
            />
            <FieldError errors={errors} name="date" inputId="birth-date" />
          </div>
          <div className="form-field">
            <label htmlFor="birth-time">出生时间</label>
            <input
              id="birth-time"
              type="time"
              required
              value={form.localTime}
              onChange={(event) => patch("localTime", event.target.value)}
              {...errorProps(errors, "localTime", "birth-time")}
            />
            <FieldError errors={errors} name="localTime" inputId="birth-time" />
          </div>
        </div>

        <fieldset className="basis-fieldset" {...(errors.timeBasis === undefined
          ? {}
          : { "aria-invalid": true, "aria-describedby": "time-basis-error" })}>
          <legend>时间口径</legend>
          <div className="basis-card-grid">
            {(["apparent_solar_provided", "civil_clock_provided"] as const).map((basis, index) => {
              const presentation = PROVIDED_TIME_PRESENTATION[basis];
              return (
                <label className={`basis-card ${form.timeBasis === basis ? "selected" : ""}`} key={basis}>
                  <input
                    type="radio"
                    name="time-basis"
                    value={basis}
                    checked={form.timeBasis === basis}
                    required={index === 0}
                    onChange={() => patch("timeBasis", basis)}
                  />
                  <span><strong>{presentation.label}</strong><small>{basis === "apparent_solar_provided"
                    ? "把已确认的真太阳日期时间原样用于双轨计算"
                    : "把输入的当地钟表日期时间原样用于双轨计算"}</small></span>
                </label>
              );
            })}
          </div>
          {basisPresentation && <p className="basis-statement" role="note">{basisPresentation.statement}</p>}
          <FieldError errors={errors} name="timeBasis" inputId="time-basis" />
        </fieldset>

        {shouldShowLateZiChoice(form) && (
          <div className="conditional-option" role="note">
            <div>
              <strong>23 点晚子时</strong>
              <p>默认同时保留当日与次日换日两种候选，便于后续审计。</p>
            </div>
            <label htmlFor="late-zi-policy">换日口径</label>
            <select
              id="late-zi-policy"
              value={form.lateZi}
              onChange={(event) => patch("lateZi", event.target.value as ProvidedTimeFormState["lateZi"])}
            >
              <option value="candidates">保留两种换日</option>
              <option value="current_day">只按当日</option>
              <option value="next_day">只按次日</option>
            </select>
          </div>
        )}

        <div className="form-field target-years-field">
          <label htmlFor="target-years">目标流年（可选）</label>
          <input
            id="target-years"
            value={form.targetYears}
            onChange={(event) => patch("targetYears", event.target.value)}
            placeholder="例如 2026、2027；不填则只排本命盘"
            {...errorProps(errors, "targetYears", "target-years")}
          />
          <FieldError errors={errors} name="targetYears" inputId="target-years" />
        </div>

        <details className="optional-evidence">
          <summary>更多选项（农历、化名与资料说明）</summary>
          <div className="optional-fields">
            <div className="form-field">
              <label htmlFor="case-alias">案例化名（可选）</label>
              <input id="case-alias" value={form.alias} onChange={(event) => patch("alias", event.target.value)} placeholder="不填则使用自动编号" />
            </div>
            <div className="form-field">
              <label htmlFor="private-name">真实姓名（可选，仅私密保存）</label>
              <input id="private-name" value={form.privateName} onChange={(event) => patch("privateName", event.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="calendar-type">历法</label>
              <select id="calendar-type" value={form.calendarType} onChange={(event) => patch("calendarType", event.target.value as ProvidedTimeFormState["calendarType"])}>
                <option value="solar">公历</option>
                <option value="lunar">农历</option>
              </select>
            </div>
            {shouldShowLeapMonthChoice(form) && (
              <div className="form-field">
                <label htmlFor="leap-month">闰月状态</label>
                <select
                  id="leap-month"
                  value={form.leapMonth === "unknown" ? "unknown" : form.leapMonth ? "leap" : "regular"}
                  onChange={(event) => patch("leapMonth", event.target.value === "unknown" ? "unknown" : event.target.value === "leap")}
                >
                  <option value="regular">普通月</option>
                  <option value="leap">闰月</option>
                  <option value="unknown">不确定，保留两种候选</option>
                </select>
              </div>
            )}
            <div className="form-field">
              <label htmlFor="time-precision">时间精度</label>
              <select id="time-precision" value={form.precision} onChange={(event) => patch("precision", event.target.value as ProvidedTimeFormState["precision"])}>
                <option value="minute">精确到分钟</option>
                <option value="approximate">约略时间</option>
                <option value="branch">仅知时辰</option>
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="source-type">资料来源</label>
              <select id="source-type" value={form.sourceType} onChange={(event) => patch("sourceType", event.target.value as ProvidedTimeFormState["sourceType"])}>
                {SOURCE_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </div>
            <div className="form-field wide">
              <label htmlFor="source-note">来源说明（可选，仅私密保存）</label>
              <input id="source-note" value={form.sourceNote} onChange={(event) => patch("sourceNote", event.target.value)} />
            </div>
            <div className="form-field wide">
              <label htmlFor="birthplace-note">出生地补充说明（可选，仅作私密证据）</label>
              <input id="birthplace-note" value={form.birthplaceNote} onChange={(event) => patch("birthplaceNote", event.target.value)} />
            </div>
          </div>
        </details>
      </div>

      <div className="form-actions">
        <button type="button" className="button ghost" onClick={onCancel}>取消</button>
        <button className="button primary" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}
          计算并保存新修订
        </button>
      </div>
    </form>
  );
}
