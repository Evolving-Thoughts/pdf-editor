import {
  checkExportAbort,
  compressionDimensions,
  COMPRESSION_PRESETS,
  type ImageEncoder,
} from "../pdf/compressPdf";

/** Local browser adapter. Opaque images only; no upload, no PDF-page rastering. */
export const encodeCompressedImage: ImageEncoder = async (
  image,
  preset,
  signal,
) => {
  checkExportAbort(signal);
  const source = document.createElement("canvas"),
    output = document.createElement("canvas");
  let bitmap: ImageBitmap | undefined;
  try {
    source.width = image.width;
    source.height = image.height;
    const ctx = source.getContext("2d");
    if (!ctx)
      throw new Error(
        "Bildkomprimierung ist in diesem Browser nicht verfügbar.",
      );
    if (image.kind === "jpeg") {
      bitmap = await createImageBitmap(
        new Blob([new Uint8Array(image.bytes)], { type: "image/jpeg" }),
        { imageOrientation: "none" },
      );
      if (bitmap.width !== image.width || bitmap.height !== image.height)
        throw new Error("Ungültige Bildabmessungen.");
      ctx.drawImage(bitmap, 0, 0);
    } else {
      const pixels = ctx.createImageData(image.width, image.height);
      for (
        let p = 0, i = 0;
        p < image.width * image.height;
        p++, i += image.channels
      ) {
        const offset = p * 4;
        pixels.data[offset] = image.bytes[i];
        pixels.data[offset + 1] =
          image.bytes[i + (image.channels === 3 ? 1 : 0)];
        pixels.data[offset + 2] =
          image.bytes[i + (image.channels === 3 ? 2 : 0)];
        pixels.data[offset + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
    }
    checkExportAbort(signal);
    const size = compressionDimensions(image.width, image.height, preset);
    output.width = size.width;
    output.height = size.height;
    const target = output.getContext("2d", { willReadFrequently: true });
    if (!target) throw new Error("Bildkomprimierung ist nicht verfügbar.");
    target.imageSmoothingEnabled = true;
    target.imageSmoothingQuality = "high";
    target.drawImage(source, 0, 0, size.width, size.height);
    const rgba = target.getImageData(0, 0, size.width, size.height).data;
    const rgb = new Uint8Array(size.width * size.height * 3);
    for (let i = 0, p = 0; i < rgba.length; i += 4, p += 3) {
      rgb[p] = rgba[i];
      rgb[p + 1] = rgba[i + 1];
      rgb[p + 2] = rgba[i + 2];
    }
    const blob = await new Promise<Blob>((resolve, reject) =>
      output.toBlob(
        (value) =>
          value?.type === "image/jpeg"
            ? resolve(value)
            : reject(new Error("JPEG-Komprimierung fehlgeschlagen.")),
        "image/jpeg",
        COMPRESSION_PRESETS[preset].jpegQuality,
      ),
    );
    checkExportAbort(signal);
    return { ...size, rgb, jpeg: new Uint8Array(await blob.arrayBuffer()) };
  } finally {
    bitmap?.close();
    source.width = source.height = output.width = output.height = 0;
  }
};
