import { zip } from "../src";

/** A PNG as far as its first bytes tell. */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

/** A workbook as Excel writes one: shared strings, an inline string, a number, a boolean, a gap between columns. */
export function xlsxFixture(): Uint8Array {
  return zip([
    [
      "xl/workbook.xml",
      '<workbook><sheets><sheet name="Preços &amp; prazos" sheetId="1" r:id="rId1"/><sheet name="Vazia" sheetId="2" r:id="rId2"/></sheets></workbook>',
    ],
    [
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    ],
    [
      "xl/sharedStrings.xml",
      "<sst><si><t>Item</t></si><si><t>Preço</t></si><si><r><t>Café, </t></r><r><t>moído</t></r></si></sst>",
    ],
    [
      "xl/worksheets/sheet1.xml",
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="inlineStr"><is><t>sim</t></is></c><c r="C2"><v>12.5</v></c><c r="D2" t="b"><v>1</v></c></row></sheetData></worksheet>',
    ],
    ["xl/worksheets/sheet2.xml", "<worksheet><sheetData/></worksheet>"],
  ]);
}

export function pptxFixture(): Uint8Array {
  return zip([
    ["ppt/slides/slide10.xml", "<p:sld><a:p><a:r><a:t>Dez</a:t></a:r></a:p></p:sld>"],
    [
      "ppt/slides/slide2.xml",
      "<p:sld><a:p><a:r><a:t>Metas &amp; prazos</a:t></a:r></a:p><a:p><a:r><a:t>Q4</a:t></a:r></a:p></p:sld>",
    ],
    ["ppt/presentation.xml", "<p:presentation/>"],
  ]);
}
