import type { ExportResult } from "../model";

export class Downloads {
  private urls = new Map<string, ReturnType<typeof setTimeout>>();

  save(result: ExportResult): void {
    const url = URL.createObjectURL(result.blob);
    const release = () => {
      const timer = this.urls.get(url);
      if (timer !== undefined) clearTimeout(timer);
      this.urls.delete(url);
      URL.revokeObjectURL(url);
    };
    this.urls.set(url, setTimeout(release, 30000));
    const link = document.createElement("a");
    link.href = url;
    link.download = result.filename;
    try {
      document.body.append(link);
      link.click();
    } catch (error) {
      release();
      throw error;
    } finally {
      link.remove();
    }
  }

  clear(): void {
    for (const [url, timer] of this.urls) {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
    }
    this.urls.clear();
  }
}
