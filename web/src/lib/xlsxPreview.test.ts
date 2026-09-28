import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { parseXlsxFirstSheet } from "./xlsxPreview";

/** 手工构造最小 xlsx（zip 包内的 OOXML 部件），覆盖共享字符串/内联字符串/数值/稀疏单元格 */
async function buildXlsx(parts: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(parts)) zip.file(path, content);
  return zip.generateAsync({ type: "arraybuffer" });
}

describe("parseXlsxFirstSheet", () => {
  it("解析首表：共享字符串 + 内联字符串 + 数值，稀疏单元格补空串", async () => {
    const buffer = await buildXlsx({
      "xl/workbook.xml":
        '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="月度报表" sheetId="1" r:id="rId1"/><sheet name="备份" sheetId="2" r:id="rId2"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
      "xl/worksheets/sheet1.xml":
        '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>内联名称</t></is></c><c r="C2"><v>42.5</v></c></row>' +
        "</sheetData></worksheet>",
      "xl/sharedStrings.xml":
        '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>名称</t></si><si><t>金额</t></si></sst>',
    });

    const preview = await parseXlsxFirstSheet(buffer);
    expect(preview.sheetName).toBe("月度报表");
    expect(preview.truncated).toBe(false);
    expect(preview.rows).toEqual([
      ["名称", "金额", ""],
      ["内联名称", "", "42.5"],
    ]);
  });

  it("缺工作表部件时抛错（调用方降级为下载）", async () => {
    const buffer = await buildXlsx({
      "xl/workbook.xml": "<workbook><sheets></sheets></workbook>",
    });
    await expect(parseXlsxFirstSheet(buffer)).rejects.toThrow();
  });
});
