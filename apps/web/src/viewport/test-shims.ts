/**
 * Test-environment shims for browser APIs jsdom does not implement.
 *
 * FileReader (needed by Three.js GLTFExporter to assemble binary GLB) and
 * URL.createObjectURL (needed for the download link) are both absent in jsdom.
 * The FileReader delegates to the real Blob bytes and the object URLs are
 * opaque test strings — the exporter, the bytes and the loader stay genuine.
 * Shipped code never imports this module.
 */

export function installViewportTestShims(): void {
  if (typeof FileReader === "undefined") {
    class TestFileReader {
      result: ArrayBuffer | string | null = null;
      onloadend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsArrayBuffer(blob: Blob): void {
        blob
          .arrayBuffer()
          .then((buffer) => {
            this.result = buffer;
            this.onloadend?.();
          })
          .catch(() => this.onerror?.());
      }
      readAsDataURL(blob: Blob): void {
        blob
          .arrayBuffer()
          .then((buffer) => {
            const base64 = Buffer.from(buffer).toString("base64");
            this.result = `data:${blob.type || "application/octet-stream"};base64,${base64}`;
            this.onloadend?.();
          })
          .catch(() => this.onerror?.());
      }
    }
    (globalThis as unknown as { FileReader: typeof TestFileReader }).FileReader = TestFileReader;
  }
  if (typeof URL.createObjectURL !== "function") {
    let next = 0;
    (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = () => {
      next += 1;
      return `blob:test-${next}`;
    };
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => {};
  }
}
