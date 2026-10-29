/** A file returned as an attachment. */
export interface DownloadedFile {
  /** File name from `Content-Disposition`, when the server sent one. */
  filename: string | undefined;
  blob: Blob;
}

export function attachmentFilename(headers: Headers): string | undefined {
  const disposition = headers.get('Content-Disposition');
  if (!disposition) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // Fall through to the plain parameter.
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(disposition);
  return plain ? (plain[2] ?? plain[1]!).trim() : undefined;
}
