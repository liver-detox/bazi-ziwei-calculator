import type { ReactElement } from "react";

function printLine(line: string, index: number): ReactElement | null {
  if (line.startsWith("##### ")) return <h5 key={index}>{line.slice(6)}</h5>;
  if (line.startsWith("#### ")) return <h4 key={index}>{line.slice(5)}</h4>;
  if (line.startsWith("### ")) return <h3 key={index}>{line.slice(4)}</h3>;
  if (line.startsWith("## ")) return <h2 key={index}>{line.slice(3)}</h2>;
  if (line.startsWith("# ")) return <h1 key={index}>{line.slice(2)}</h1>;
  if (line.startsWith("> ")) return <p className="chart-document-print-note" key={index}>{line.slice(2)}</p>;
  if (line.startsWith("- ")) return <p className="chart-document-print-field" key={index}>{line.slice(2)}</p>;
  return line === "" ? null : <p key={index}>{line}</p>;
}

export function ChartDocumentPrintout({ text }: { text: string }): ReactElement | null {
  if (text === "") return null;
  return <article aria-label="八字与紫微斗数打印内容" className="chart-document-printout">{text.split("\n").map(printLine)}</article>;
}
