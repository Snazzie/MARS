import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Disclosure } from "./Disclosure.tsx";

test("renders a labeled native disclosure closed by default", () => {
  const markup = renderToStaticMarkup(<Disclosure label="GitHub connection"><p>Sync controls</p></Disclosure>);
  expect(markup).toContain("GitHub connection");
  expect(markup).toContain("<details");
  expect(markup).not.toContain("<details open");
});
