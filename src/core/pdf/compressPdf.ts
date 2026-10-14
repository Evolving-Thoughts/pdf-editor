import {
  decodePDFRawStream,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
} from "pdf-lib";
import { inspectImage } from "../images/imageFormat";

export const COMPRESSION_PRESETS = {
  high: { label: "Hohe Qualität", maxEdge: 2400, jpegQuality: 0.9 },
  balanced: { label: "Ausgewogen", maxEdge: 1800, jpegQuality: 0.8 },
  small: { label: "Kleinere Datei", maxEdge: 1200, jpegQuality: 0.65 },
} as const;
export type CompressionPreset = keyof typeof COMPRESSION_PRESETS;
export const MAX_COMPRESSION_PIXELS = 16_000_000;
export type ImageInput = {
  width: number;
  height: number;
  bytes: Uint8Array;
} & ({ kind: "pixels"; channels: 1 | 3 } | { kind: "jpeg" });
export interface EncodedImage {
  width: number;
  height: number;
  rgb: Uint8Array;
  jpeg: Uint8Array;
}
export type ImageEncoder = (
  image: ImageInput,
  preset: CompressionPreset,
  signal?: AbortSignal,
) => Promise<EncodedImage>;
export interface CompressionResult {
  bytes: Uint8Array;
  originalSize: number;
  optimizedImages: number;
  unchangedImages: number;
  failedImages: number;
}
export function checkExportAbort(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException("Export abgebrochen.", "AbortError");
}
export function compressionDimensions(
  width: number,
  height: number,
  preset: CompressionPreset,
) {
  const scale = Math.min(
    1,
    COMPRESSION_PRESETS[preset].maxEdge / Math.max(width, height),
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
const key = PDFName.of;

/** PDF DCT pixels must not acquire browser EXIF orientation/ICC conversion.
 * Skip such JPEGs rather than changing their appearance, including square images. */
function plainJpeg(bytes: Uint8Array, channels: number) {
  let offset = 2,
    components = 0;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return components === channels;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return false;
    if (marker === 0xe1 || marker === 0xe2) return false;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      if (length < 8 || bytes[offset + 2] !== 8) return false;
      components = bytes[offset + 7];
    }
    offset += length;
  }
  return false;
}

/** Optimize only ordinary, opaque 8-bit RGB/gray image XObjects. Unsupported
 * color spaces, masks, predictors and inline images stay untouched. Never
 * render a whole PDF page: text, vectors, annotations and AcroForms survive.
 * Encoding is injected so the PDF policy is testable without DOM/React. */
export async function compressPdf(
  bytes: Uint8Array,
  preset: CompressionPreset,
  encode: ImageEncoder,
  options: {
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<CompressionResult> {
  if (!Object.hasOwn(COMPRESSION_PRESETS, preset))
    throw new Error("Ungültige Komprimierungsstufe.");
  const { signal, onProgress } = options;
  checkExportAbort(signal);
  const doc = await PDFDocument.load(bytes.slice(), { updateMetadata: false });
  const images = doc.context
    .enumerateIndirectObjects()
    .filter(
      ([, object]) =>
        object instanceof PDFRawStream &&
        object.dict.get(key("Subtype")) === key("Image"),
    );
  const result: CompressionResult = {
    bytes,
    originalSize: bytes.length,
    optimizedImages: 0,
    unchangedImages: 0,
    failedImages: 0,
  };
  for (const [index, [ref, object]] of images.entries()) {
    checkExportAbort(signal);
    const stream = object as PDFRawStream,
      dict = stream.dict;
    try {
      const width = dict.lookupMaybe(key("Width"), PDFNumber)?.asNumber() ?? 0;
      const height =
        dict.lookupMaybe(key("Height"), PDFNumber)?.asNumber() ?? 0;
      const bits = dict
        .lookupMaybe(key("BitsPerComponent"), PDFNumber)
        ?.asNumber();
      const color = dict.get(key("ColorSpace")),
        filter = dict.get(key("Filter"));
      const channels =
        color === key("DeviceRGB") ? 3 : color === key("DeviceGray") ? 1 : 0;
      // These entries can change how pixels are interpreted. Never guess.
      const special = [
        "SMask",
        "Mask",
        "ImageMask",
        "Decode",
        "DecodeParms",
        "SMaskInData",
        "Alternates",
        "F",
        "FFilter",
        "FDecodeParms",
      ].some((name) => dict.has(key(name)));
      if (
        special ||
        !channels ||
        bits !== 8 ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        width * height > MAX_COMPRESSION_PIXELS ||
        width * height < 4096 ||
        stream.contents.length < 2048 ||
        (filter !== key("FlateDecode") && filter !== key("DCTDecode"))
      ) {
        result.unchangedImages++;
        continue;
      }
      let input: ImageInput;
      if (filter === key("DCTDecode")) {
        if (!plainJpeg(stream.contents, channels)) {
          result.unchangedImages++;
          continue;
        }
        const info = inspectImage(stream.contents);
        if (info.width !== width || info.height !== height)
          throw new Error("Ungültige JPEG-Abmessungen.");
        input = { kind: "jpeg", width, height, bytes: stream.contents };
      } else {
        const expected = width * height * channels;
        const pixels = decodePDFRawStream(stream).getBytes(expected + 1);
        if (pixels.length !== expected) throw new Error("Ungültige Bilddaten.");
        input = {
          kind: "pixels",
          channels,
          width,
          height,
          bytes: new Uint8Array(pixels),
        };
      }
      const encoded = await encode(input, preset, signal);
      checkExportAbort(signal);
      const target = compressionDimensions(width, height, preset);
      if (
        encoded.width !== target.width ||
        encoded.height !== target.height ||
        encoded.rgb.length !== encoded.width * encoded.height * 3
      )
        throw new Error("Ungültige komprimierte Bilddaten.");
      const jpeg = inspectImage(encoded.jpeg);
      if (
        jpeg.width !== encoded.width ||
        jpeg.height !== encoded.height ||
        encoded.jpeg[0] !== 0xff ||
        encoded.jpeg[1] !== 0xd8
      )
        throw new Error("Ungültige JPEG-Ausgabe.");
      // PNG-style lossless pixel deflation can beat JPEG for document scans.
      // Compare actual stream sizes, not estimated compression ratios.
      const lossless = doc.context.flateStream(encoded.rgb).contents;
      const useJpeg = encoded.jpeg.length < lossless.length;
      const contents = useJpeg ? encoded.jpeg : lossless;
      if (contents.length >= stream.contents.length) {
        result.unchangedImages++;
        continue;
      }
      const next = dict.clone(doc.context);
      next.set(key("Width"), PDFNumber.of(encoded.width));
      next.set(key("Height"), PDFNumber.of(encoded.height));
      next.set(key("ColorSpace"), key("DeviceRGB"));
      next.set(key("Filter"), key(useJpeg ? "DCTDecode" : "FlateDecode"));
      // Same reference: placement/resource links remain intact; no duplicate or
      // abandoned original pixel stream is left in the optimized output.
      doc.context.assign(ref, PDFRawStream.of(next, contents));
      result.optimizedImages++;
    } catch (error) {
      checkExportAbort(signal);
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
      result.failedImages++; // This image stays intact; disclose partial optimization.
    } finally {
      onProgress?.(index + 1, images.length);
    }
  }
  checkExportAbort(signal);
  if (result.optimizedImages) {
    const optimized = await doc.save({ updateFieldAppearances: false });
    checkExportAbort(signal);
    if (optimized.length < bytes.length) result.bytes = optimized;
    else {
      result.unchangedImages += result.optimizedImages;
      result.optimizedImages = 0;
    }
  }
  return result;
}
