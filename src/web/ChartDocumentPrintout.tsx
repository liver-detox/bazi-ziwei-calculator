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
  const lines = text.split("\n");
  const content: Array<ReactElement | null> = [];
  const cells = (line: string) => line.slice(1, -1).split("|").map((cell) => cell.trim());
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith("| ") && /^\|(?:\s*---\s*\|)+$/u.test(lines[index + 1] ?? "")) {
      const key = index;
      const headings = cells(lines[index]);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].startsWith("| ")) {
        rows.push(cells(lines[index]));
        index += 1;
      }
      index -= 1;
      content.push(<table key={key}><thead><tr>{headings.map((heading, column) => <th key={column}>{heading}</th>)}</tr></thead><tbody>{rows.map((row, number) => <tr key={number}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table>);
    } else {
      content.push(printLine(lines[index], index));
    }
  }
  return <article aria-label="八字与紫微斗数打印内容" className="chart-document-printout">{content}</article>;
}
