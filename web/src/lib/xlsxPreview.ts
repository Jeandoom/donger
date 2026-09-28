export interface XlsxPreview {
  sheetName: string;
  /** 单元格文本矩阵（稀疏补空串）；超出 MAX_PREVIEW_ROWS 的行不进 rows */
  rows: string[][];
  totalRows: number;
  truncated: boolean;
}

/** 基本预览的行数上限（防大表卡渲染；超出部分提示用 Excel 打开） */
const MAX_PREVIEW_ROWS = 200;

/** 列字母引用 → 0 起下标（A→0, AA→26） */
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    if (ch >= "A" && ch <= "Z") n = n * 26 + (ch.charCodeAt(0) - 64);
    else if (ch >= "a" && ch <= "z") n = n * 26 + (ch.charCodeAt(0) - 96);
    else break;
  }
  return n - 1;
}

function textOf(el: Element | null | undefined): string {
  return el?.textContent ?? "";
}

function firstText(parent: Element, tag: string): string {
  return textOf(parent.getElementsByTagName(tag)[0]);
}

/**
 * 极简 xlsx 首表解析（基本预览用）：覆盖 sharedStrings / 内联字符串 / 数值单元格，
 * 不处理日期、公式缓存外的富格式；解析失败抛错，由调用方降级为下载。
 */
export async function parseXlsxFirstSheet(buffer: ArrayBuffer): Promise<XlsxPreview> {
  // 动态加载（与 docx-preview 共享 chunk），非 xlsx 预览不进主包
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buffer);
  const parser = new DOMParser();
  const readXml = async (path: string): Promise<Document | null> => {
    const file = zip.file(path);
    if (!file) return null;
    return parser.parseFromString(await file.async("string"), "text/xml");
  };

  const workbook = await readXml("xl/workbook.xml");
  const firstSheet = workbook?.getElementsByTagName("sheet")[0];
  if (!workbook || !firstSheet) throw new Error("工作簿结构缺失");
  const sheetName = firstSheet.getAttribute("name") ?? "Sheet1";
  const rid = firstSheet.getAttribute("r:id") ?? "";

  // rId → 目标路径（Target 相对 xl/，兼容绝对形态 /xl/…）
  let target = "";
  if (rid) {
    const rels = await readXml("xl/_rels/workbook.xml.rels");
    for (const rel of rels?.getElementsByTagName("Relationship") ?? []) {
      if (rel.getAttribute("Id") === rid) target = rel.getAttribute("Target") ?? "";
    }
  }
  const sheetPath = target ? `xl/${target.replace(/^\/?(xl\/)?/, "")}` : "xl/worksheets/sheet1.xml";
  const sheet = await readXml(sheetPath);
  if (!sheet) throw new Error("工作表缺失");

  const shared: string[] = [];
  const sst = await readXml("xl/sharedStrings.xml");
  if (sst) {
    for (const si of sst.getElementsByTagName("si")) {
      shared.push([...si.getElementsByTagName("t")].map((t) => textOf(t)).join(""));
    }
  }

  const rowEls = [...sheet.getElementsByTagName("row")];
  const rows: string[][] = [];
  for (const rowEl of rowEls.slice(0, MAX_PREVIEW_ROWS)) {
    const cells: string[] = [];
    for (const c of rowEl.getElementsByTagName("c")) {
      const ref = c.getAttribute("r") ?? "";
      const idx = ref ? colIndex(ref) : cells.length;
      const t = c.getAttribute("t");
      let value: string;
      if (t === "s") {
        value = shared[Number.parseInt(firstText(c, "v"), 10)] ?? "";
      } else if (t === "inlineStr") {
        value = [...c.getElementsByTagName("t")].map((el) => textOf(el)).join("");
      } else {
        value = firstText(c, "v");
      }
      while (cells.length < idx) cells.push("");
      if (idx >= 0 && idx < 4096) cells[idx] = value;
    }
    rows.push(cells);
  }
  // 各行补齐到全局最大列宽，保证表格列对齐（稀疏行渲染不串列）
  const width = rows.reduce((acc, cells) => Math.max(acc, cells.length), 0);
  for (const cells of rows) {
    while (cells.length < width) cells.push("");
  }
  return {
    sheetName,
    rows,
    totalRows: rowEls.length,
    truncated: rowEls.length > MAX_PREVIEW_ROWS,
  };
}
