/**
 * Turns the file name of a Docmost space export back into a space name.
 *
 * The export endpoint names its download `<Space name>-space-export.zip`, and a
 * browser that already has that file adds a ` (1)` suffix. Both are noise when
 * the zip is used to recreate the space.
 *
 * "Academia Viver Sports-space-export (1).zip" -> "Academia Viver Sports"
 */
export function spaceNameFromZipFileName(fileName: string): string {
  return fileName
    .replace(/\.zip$/i, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/-space-export$/i, "")
    .trim();
}
