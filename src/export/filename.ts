export function exportBase(filename: string): string {
  return (
    filename
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, "") || "export"
  );
}
