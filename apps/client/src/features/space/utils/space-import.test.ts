import { describe, expect, it } from "vitest";
import { spaceNameFromZipFileName } from "./space-import";

describe("spaceNameFromZipFileName", () => {
  it("strips the export suffix", () => {
    expect(spaceNameFromZipFileName("Província Marcas-space-export.zip")).toBe(
      "Província Marcas",
    );
  });

  it("strips the browser duplicate-download suffix before the export suffix", () => {
    expect(
      spaceNameFromZipFileName("Academia Viver Sports-space-export (1).zip"),
    ).toBe("Academia Viver Sports");
  });

  it("only strips the last export suffix", () => {
    expect(spaceNameFromZipFileName("my-space-export-space-export.zip")).toBe(
      "my-space-export",
    );
  });

  it("accepts a zip that is not a Docmost export", () => {
    expect(spaceNameFromZipFileName("Handover (2).ZIP")).toBe("Handover");
  });
});
