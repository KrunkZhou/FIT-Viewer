import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { pageIndex, PageNumber } from "../src/ui/PageNumber";

test("manual page numbers are one-based, clamped and reject invalid input", () => {
  assert.equal(pageIndex("1", 9), 0);
  assert.equal(pageIndex(" 4 ", 9), 3);
  assert.equal(pageIndex("0", 9), 0);
  assert.equal(pageIndex("100", 9), 8);
  assert.equal(pageIndex("2", 1), 0);
  for (const value of ["", "abc", "-1", "1.5", "1e3", "9007199254740992"])
    assert.equal(pageIndex(value, 9), undefined);
});

test("page control is an accessible numeric-entry field with the current page", () => {
  const markup = renderToStaticMarkup(
    createElement(PageNumber, {
      page: 2,
      pages: 10,
      disabled: false,
      onChange() {},
    }),
  );
  assert.match(markup, /aria-label="Page number"/);
  assert.match(markup, /inputMode="numeric"/);
  assert.match(markup, /value="3"/);
  assert.match(markup, /\/ 10/);
});
