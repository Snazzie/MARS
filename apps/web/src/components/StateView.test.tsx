import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiRequestError } from "../api.ts";
import { QueryState } from "./StateView.tsx";

test("unauthorized state links to the control-plane GitHub OAuth endpoint", () => {
  const markup = renderToStaticMarkup(
    <QueryState
      error={new ApiRequestError("Your session has expired.", 401, "unauthorized")}
      isLoading={false}
    />,
  );

  expect(markup).toContain('href="/api/auth/github"');
});
