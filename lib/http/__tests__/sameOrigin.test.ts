import { describe, expect, it } from "vitest";
import { isSameOriginRequest } from "../sameOrigin";

const req = (headers: Record<string, string>) =>
  new Request("http://127.0.0.1:7878/api/x", { method: "POST", headers });

describe("isSameOriginRequest", () => {
  it("Sec-Fetch-Site が same-origin / none なら通す", () => {
    expect(isSameOriginRequest(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginRequest(req({ "sec-fetch-site": "none" }))).toBe(true);
  });

  it("Sec-Fetch-Site が cross-site / same-site なら Origin が合っていても弾く", () => {
    expect(
      isSameOriginRequest(
        req({ "sec-fetch-site": "cross-site", origin: "http://127.0.0.1:7878" }),
      ),
    ).toBe(false);
    expect(isSameOriginRequest(req({ "sec-fetch-site": "same-site" }))).toBe(false);
  });

  it("Sec-Fetch-Site が無ければ Origin の一致で判断する", () => {
    expect(isSameOriginRequest(req({ origin: "http://127.0.0.1:7878" }))).toBe(true);
    expect(isSameOriginRequest(req({ origin: "http://evil.example" }))).toBe(false);
    expect(isSameOriginRequest(req({ origin: "null" }))).toBe(false);
  });

  it("どちらのヘッダも無い非ブラウザは通す", () => {
    expect(isSameOriginRequest(req({}))).toBe(true);
  });
});
