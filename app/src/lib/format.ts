/** Short form of a Splice file name: no extension, underscores as spaces. */
export function shortName(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/_/g, " ");
}
