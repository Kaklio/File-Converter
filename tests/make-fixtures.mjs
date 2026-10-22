// Builds browser-test fixtures: a minimal .docx and a .zip containing images.
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const dir = process.argv[2] || "C:\\Users\\Aoun\\AppData\\Local\\Temp\\opencode\\fctest";
fs.mkdirSync(dir, { recursive: true });

// --- minimal docx ---
const docx = new JSZip();
docx.file(
  "[Content_Types].xml",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
);
docx.file(
  "_rels/.rels",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
);
docx.file(
  "word/document.xml",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
<w:p><w:r><w:t>This document was generated for converter testing. It has two paragraphs.</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Line three: numbers 12345 and symbols &amp; &lt; &gt;.</w:t></w:r></w:p>
</w:body></w:document>`
);
const docxBuf = await docx.generateAsync({ type: "nodebuffer" });
fs.writeFileSync(path.join(dir, "sample.docx"), docxBuf);

// --- zip containing the png fixtures ---
const shell = new JSZip();
shell.file("pic.png", fs.readFileSync(path.join(dir, "pic.png")));
shell.file("notes.txt", "not an image, should be ignored by zip→pdf\n");
const zipBuf = await shell.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
fs.writeFileSync(path.join(dir, "images.zip"), zipBuf);

console.log("fixtures written:", fs.readdirSync(dir).join(", "));
