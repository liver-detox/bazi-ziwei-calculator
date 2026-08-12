import type { CSSProperties } from "react";

export const FIVE_ELEMENT_STYLES = {
  木: { foreground: "#18763B", background: "#EAF6EE" },
  火: { foreground: "#B42318", background: "#FCEDEA" },
  土: { foreground: "#765A13", background: "#F7F0D8" },
  金: { foreground: "#A04F00", background: "#FFF0DA" },
  水: { foreground: "#155F9F", background: "#E8F2FA" }
} as const;

export type FiveElement = keyof typeof FIVE_ELEMENT_STYLES;

export const GAN_ZHI_ELEMENT_MAP = Object.freeze({
  甲: "木",
  乙: "木",
  丙: "火",
  丁: "火",
  戊: "土",
  己: "土",
  庚: "金",
  辛: "金",
  壬: "水",
  癸: "水",
  子: "水",
  丑: "土",
  寅: "木",
  卯: "木",
  辰: "土",
  巳: "火",
  午: "火",
  未: "土",
  申: "金",
  酉: "金",
  戌: "土",
  亥: "水"
} satisfies Record<string, FiveElement>);

const NEUTRAL_STYLE: CSSProperties = {
  color: "#4B5563",
  backgroundColor: "#F3F4F6"
};

export function elementForGanZhiCharacter(character: string): FiveElement | null {
  return (GAN_ZHI_ELEMENT_MAP as Readonly<Record<string, FiveElement>>)[character] ?? null;
}

export function elementForNaYin(text: string): FiveElement | null {
  const suffix = [...text.trim()].at(-1) ?? "";
  return suffix in FIVE_ELEMENT_STYLES ? suffix as FiveElement : null;
}

export function GanZhiText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      {[...text].map((character, index) => {
        const element = elementForGanZhiCharacter(character);
        if (element === null) {
          return (
            <span
              aria-label={`${character}，五行未知`}
              data-five-element="unknown"
              key={`${index}-${character}`}
              style={NEUTRAL_STYLE}
            >
              {character}
            </span>
          );
        }
        const palette = FIVE_ELEMENT_STYLES[element];
        return (
          <span
            aria-label={`${character}，五行${element}`}
            data-five-element={element}
            key={`${index}-${character}`}
            style={{ color: palette.foreground, backgroundColor: palette.background }}
          >
            {character}
          </span>
        );
      })}
    </span>
  );
}

export function NaYinText({ text }: { text: string }) {
  const element = elementForNaYin(text);
  return (
    <span className="nayin-text">
      <span>{text}</span>
      {element && (
        <span
          aria-label={`纳音五行${element}`}
          className="nayin-element"
          data-five-element={element}
          style={{ color: FIVE_ELEMENT_STYLES[element].foreground, backgroundColor: FIVE_ELEMENT_STYLES[element].background }}
        >{element}</span>
      )}
    </span>
  );
}
