import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";

describe("parseCsv", () => {
  it("基本・BOM・CRLF・末尾の改行なし", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n3,4")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });
  it("引用符・引用符内のカンマ・改行・エスケープされた引用符", () => {
    expect(parseCsv('a,"b,c","d\ne","f""g"\n')).toEqual([["a", "b,c", "d\ne", 'f"g']]);
  });
  it("空行は無視し、空欄は保持する", () => {
    expect(parseCsv("a,,c\n\n,,\nx,y,z")).toEqual([["a", "", "c"], ["x", "y", "z"]]);
  });
  it("空の入力", () => {
    expect(parseCsv("")).toEqual([]);
  });
});
