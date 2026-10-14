import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  drawObject,
} from "pdf-lib";
import {
  compressPdf,
  compressionDimensions,
  type ImageEncoder,
} from "../../src/core/pdf/compressPdf";
const fixture = JSON.parse(
  readFileSync(new URL("../compressionFixtures.json", import.meta.url), "utf8"),
);
const rgb = new Uint8Array(Buffer.from(fixture.rgb, "base64")),
  jpeg = new Uint8Array(Buffer.from(fixture.jpeg, "base64"));
const encode: ImageEncoder = async () => ({
  width: 256,
  height: 256,
  rgb: rgb.slice(),
  jpeg: jpeg.slice(),
});
async function document(extra: Record<string, unknown> = {}) {
  const doc = await PDFDocument.create(),
    page = doc.addPage([400, 600]);
  const dict = {
    Type: "XObject",
    Subtype: "Image",
    Width: 256,
    Height: 256,
    ColorSpace: "DeviceRGB",
    BitsPerComponent: 8,
    ...extra,
  };
  const ref = doc.context.register(doc.context.flateStream(rgb, dict));
  page.node.set(
    PDFName.of("Resources"),
    doc.context.obj({ XObject: { Picture: ref } }),
  );
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(256, 0, 0, 256, 0, 0),
    drawObject("Picture"),
    popGraphicsState(),
  );
  page.drawText("PUBLIC-TEXT");
  doc.setTitle("Keep metadata");
  const field = doc.getForm().createTextField("Name");
  field.setText("Ada");
  field.addToPage(page, { x: 20, y: 500, width: 100, height: 25 });
  return { doc, ref, bytes: await doc.save() };
}
function image(doc: PDFDocument) {
  return doc.context
    .enumerateIndirectObjects()
    .map(([, o]) => o)
    .find(
      (o) =>
        o instanceof PDFRawStream &&
        o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"),
    ) as PDFRawStream;
}
test("compresses opaque images while keeping references, text, metadata and editable forms; source immutable", async () => {
  const { bytes, ref } = await document(),
    before = bytes.slice(),
    result = await compressPdf(bytes, "balanced", encode);
  expect(result.bytes.length).toBeLessThan(bytes.length);
  expect(result.optimizedImages).toBe(1);
  expect(bytes).toEqual(before);
  const output = await PDFDocument.load(result.bytes);
  expect(output.context.lookup(ref)).toBeInstanceOf(PDFRawStream);
  expect(image(output).dict.get(PDFName.of("Filter"))).toBe(
    PDFName.of("DCTDecode"),
  );
  expect(output.getForm().getTextField("Name").getText()).toBe("Ada");
  expect(output.getTitle()).toBe("Keep metadata");
  output.getForm().getTextField("Name").setText("Editable");
  expect(
    (await PDFDocument.load(await output.save()))
      .getForm()
      .getTextField("Name")
      .getText(),
  ).toBe("Editable");
  const streams = output.context
    .enumerateIndirectObjects()
    .map(([, o]) => {
      try {
        return o instanceof PDFRawStream
          ? Buffer.from(decodePDFRawStream(o).decode()).toString()
          : "";
      } catch {
        return "";
      }
    })
    .join("\n");
  expect(streams).toContain("5055424C49432D54455854");
});
test("compares pixel deflation with JPEG and selects the smaller format", async () => {
  const { bytes } = await document();
  const result = await compressPdf(bytes, "high", async () => ({
    width: 256,
    height: 256,
    rgb: new Uint8Array(rgb.length).fill(255),
    jpeg,
  }));
  expect(
    image(await PDFDocument.load(result.bytes)).dict.get(PDFName.of("Filter")),
  ).toBe(PDFName.of("FlateDecode"));
  expect(result.bytes.length).toBeLessThan(bytes.length);
});
test("never returns a larger image or PDF; returns exact original when no saving", async () => {
  const { bytes } = await document();
  const hugeJpeg = new Uint8Array(rgb.length * 2);
  hugeJpeg.set(jpeg);
  const result = await compressPdf(bytes, "high", async () => ({
    width: 256,
    height: 256,
    rgb,
    jpeg: hugeJpeg,
  }));
  expect(result.bytes).toBe(bytes);
  expect(result.optimizedImages).toBe(0);
});
for (const extra of [
  { SMask: "Unsupported" },
  { Mask: [0, 1] },
  { Decode: [0, 1, 0, 1, 0, 1] },
  { DecodeParms: { Predictor: 15 } },
  { ColorSpace: "DeviceCMYK" },
  { BitsPerComponent: 1 },
  { ImageMask: true },
  { Width: 50000, Height: 50000 },
  { Width: 1, Height: 1 },
])
  test(`keeps unsupported/unsafe image unchanged: ${JSON.stringify(extra)}`, async () => {
    const { bytes } = await document(extra);
    let calls = 0;
    const result = await compressPdf(bytes, "small", async (...args) => {
      calls++;
      return encode(...args);
    });
    expect(calls).toBe(0);
    expect(result.bytes).toBe(bytes);
    expect(result.unchangedImages).toBe(1);
  });
test("individual decoder/encoder failure is disclosed and leaves original intact", async () => {
  const { bytes } = await document();
  const result = await compressPdf(bytes, "balanced", async () => {
    throw new Error("Unsupported browser");
  });
  expect(result.bytes).toBe(bytes);
  expect(result.failedImages).toBe(1);
  const invalid = await compressPdf(bytes, "balanced", async () => ({
    width: 1,
    height: 1,
    rgb: new Uint8Array(3),
    jpeg,
  }));
  expect(invalid.failedImages).toBe(1);
  expect(invalid.bytes).toBe(bytes);
});
test("presets bound image dimensions and never upscale", () => {
  expect(compressionDimensions(2480, 3508, "balanced")).toEqual({
    width: 1273,
    height: 1800,
  });
  expect(compressionDimensions(300, 200, "small")).toEqual({
    width: 300,
    height: 200,
  });
  expect(compressionDimensions(5000, 3000, "high")).toEqual({
    width: 2400,
    height: 1440,
  });
});
test("cancellation before loading and after encoding never returns output", async () => {
  const { bytes } = await document();
  const controller = new AbortController();
  controller.abort();
  await expect(
    compressPdf(bytes, "balanced", encode, { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  const next = new AbortController(),
    copy = bytes.slice();
  await expect(
    compressPdf(
      bytes,
      "balanced",
      async (...args) => {
        next.abort();
        return encode(...args);
      },
      { signal: next.signal },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(bytes).toEqual(copy);
});
test("invalid preset is rejected explicitly", async () => {
  const { bytes } = await document();
  await expect(compressPdf(bytes, "invalid" as "high", encode)).rejects.toThrow(
    "Komprimierungsstufe",
  );
});
test("empty/vector-only PDF is returned byte-for-byte without image work", async () => {
  const doc = await PDFDocument.create();
  doc.addPage().drawText("Searchable");
  const bytes = await doc.save();
  const result = await compressPdf(bytes, "small", () => {
    throw new Error("must not run");
  });
  expect(result.bytes).toBe(bytes);
  expect(result.optimizedImages).toBe(0);
});
test("malformed pixel lengths fail closed for the image, not the document", async () => {
  const { doc, bytes } = await document();
  const stream = image(doc),
    next = doc.context.flateStream(
      rgb.slice(0, 4096),
      Object.fromEntries(
        stream.dict
          .entries()
          .filter(
            ([k]) => k !== PDFName.of("Length") && k !== PDFName.of("Filter"),
          )
          .map(([k, v]) => [k.decodeText(), v]),
      ),
    );
  const ref = doc.context
    .enumerateIndirectObjects()
    .find(([, o]) => o === stream)![0];
  doc.context.assign(ref, next);
  const malformed = await doc.save();
  expect(malformed).not.toEqual(bytes);
  const result = await compressPdf(malformed, "high", encode);
  expect(result.bytes).toBe(malformed);
  expect(result.failedImages).toBe(1);
});

test("supports ordinary JPEG streams without browser metadata reinterpretation", async () => {
  const { doc, ref } = await document();
  const stream = image(doc),
    dict = stream.dict.clone(doc.context);
  dict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
  doc.context.assign(ref, PDFRawStream.of(dict, jpeg));
  const bytes = await doc.save();
  const result = await compressPdf(bytes, "high", async (input) => {
    expect(input.kind).toBe("jpeg");
    return {
      width: 256,
      height: 256,
      rgb: new Uint8Array(rgb.length).fill(255),
      jpeg,
    };
  });
  expect(result.optimizedImages).toBe(1);
  expect(result.bytes.length).toBeLessThan(bytes.length);
});
for (const marker of [0xe1, 0xe2])
  test(`skips JPEG APP${marker - 0xe0} metadata, even with square dimensions`, async () => {
    const { doc, ref } = await document(),
      dict = image(doc).dict.clone(doc.context);
    const modified = new Uint8Array(jpeg.length + 6);
    modified.set(jpeg.slice(0, 2));
    modified.set([255, marker, 0, 4, 0, 0], 2);
    modified.set(jpeg.slice(2), 8);
    dict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
    doc.context.assign(ref, PDFRawStream.of(dict, modified));
    const bytes = await doc.save();
    let calls = 0;
    const result = await compressPdf(bytes, "high", async (...args) => {
      calls++;
      return encode(...args);
    });
    expect(calls).toBe(0);
    expect(result.bytes).toBe(bytes);
    expect(result.unchangedImages).toBe(1);
  });

test("passes grayscale pixel channels explicitly to the encoder", async () => {
  const { doc, ref } = await document(),
    dict = image(doc).dict.clone(doc.context);
  dict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceGray"));
  doc.context.assign(
    ref,
    PDFRawStream.of(
      dict,
      doc.context.flateStream(rgb.slice(0, 256 * 256)).contents,
    ),
  );
  const bytes = await doc.save();
  const result = await compressPdf(bytes, "high", async (input) => {
    expect(input.kind).toBe("pixels");
    if (input.kind === "pixels") expect(input.channels).toBe(1);
    expect(input.bytes.length).toBe(256 * 256);
    return {
      width: 256,
      height: 256,
      rgb: new Uint8Array(rgb.length).fill(128),
      jpeg,
    };
  });
  expect(result.optimizedImages).toBe(1);
});
