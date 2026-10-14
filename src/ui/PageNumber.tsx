import { useEffect, useState } from "react";

export function pageIndex(value: string, pages: number): number | undefined {
  if (!/^\d+$/.test(value.trim())) return;
  const page = Number(value);
  if (!Number.isSafeInteger(page)) return;
  return Math.max(0, Math.min(pages - 1, page - 1));
}

export function PageNumber({
  page,
  pages,
  disabled,
  onChange,
}: {
  page: number;
  pages: number;
  disabled: boolean;
  onChange: (page: number) => void;
}) {
  const [value, setValue] = useState(String(page + 1));
  useEffect(() => setValue(String(page + 1)), [page, pages]);
  const submit = () => {
    const next = pageIndex(value, pages);
    setValue(String((next ?? page) + 1));
    if (next !== undefined && next !== page) onChange(next);
  };
  return (
    <span className="viewer-pagination-page">
      Page{" "}
      <input
        className="viewer-page-number"
        aria-label="Page number"
        title={`Go to page (1-${pages})`}
        type="text"
        inputMode="numeric"
        value={value}
        size={Math.max(1, String(pages).length)}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onFocus={(event) => event.target.select()}
        onBlur={submit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setValue(String(page + 1));
          }
        }}
      />{" "}
      / {pages}
    </span>
  );
}
